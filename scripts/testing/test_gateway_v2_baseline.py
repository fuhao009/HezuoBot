import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "gateway-v2-baseline.py"
SPEC = importlib.util.spec_from_file_location("gateway_v2_baseline", SCRIPT)
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)


class GatewayV2BaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.migrations = self.root / "migrations"
        self.migrations.mkdir()
        self.first_sql = (
            'CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, '
            'name TEXT NOT NULL UNIQUE);\n'
            'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER, '
            'value TEXT DEFAULT \'unset\', '
            'FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE);\n'
            'CREATE INDEX child_value ON child(value DESC) WHERE value IS NOT NULL;\n'
            'CREATE TRIGGER child_insert AFTER INSERT ON child BEGIN '
            'UPDATE child SET value = \'created\' WHERE id = NEW.id; END;\n'
        )
        self.write_migration("0002_more.sql", "ALTER TABLE child ADD COLUMN extra TEXT;")
        self.write_migration("0001_initial.sql", self.first_sql)

    def write_migration(self, name, sql):
        path = self.migrations / name
        path.write_text(sql, encoding="utf-8")
        return path

    def build(self):
        return baseline.build_baseline(self.migrations)

    def cli(self, *args, migrations=True):
        command = [sys.executable, str(SCRIPT)]
        if migrations:
            command.extend(["--migrations-dir", str(self.migrations)])
        return subprocess.run(command + list(map(str, args)), cwd=self.root,
                              capture_output=True, text=True, encoding="utf-8")

    def test_ordered_migrations_and_complete_schema(self):
        result = self.build()
        self.assertEqual([item["path"] for item in result["migrations"]],
                         ["0001_initial.sql", "0002_more.sql"])
        self.assertEqual(result["migrations"][0]["sha256"],
                         hashlib.sha256(self.first_sql.encode("utf-8")).hexdigest())
        tables = {table["name"]: table for table in result["tables"]}
        self.assertEqual(set(tables), {"parent", "child"})
        child = tables["child"]
        self.assertEqual([column["name"] for column in child["columns"]],
                         ["id", "parent_id", "value", "extra"])
        self.assertEqual(child["columns"][2]["dflt_value"], "'unset'")
        self.assertEqual(child["columns"][0]["pk"], 1)
        self.assertEqual(tables["parent"]["columns"][1]["notnull"], 1)
        self.assertEqual(child["fks"][0]["table"], "parent")
        self.assertEqual(child["fks"][0]["from"], "parent_id")
        self.assertEqual(child["fks"][0]["to"], "id")
        self.assertEqual(child["fks"][0]["on_delete"], "CASCADE")
        index = child["indexes"][0]
        self.assertEqual(index["name"], "child_value")
        self.assertEqual(index["partial"], 1)
        self.assertEqual(index["columns"][0]["desc"], 1)
        self.assertIn("WHERE value IS NOT NULL", index["sql"])
        self.assertTrue(any(index["origin"] == "u" and index["unique"] == 1
                            for index in tables["parent"]["indexes"]))
        self.assertEqual(child["triggers"][0]["name"], "child_insert")
        self.assertIn("UPDATE child", child["triggers"][0]["sql"])

    def test_generated_columns_expression_indexes_and_quoted_identifiers(self):
        self.write_migration("0003_special.sql", '''
CREATE TABLE "odd'""name" (value TEXT, derived TEXT GENERATED ALWAYS AS (upper(value)) VIRTUAL);
CREATE INDEX odd_expression ON "odd'""name" (lower(value));
''')
        table = next(table for table in self.build()["tables"] if table["name"] == 'odd\'"name')
        self.assertEqual(table["columns"][1]["hidden"], 2)
        self.assertEqual(table["indexes"][0]["columns"][0]["cid"], -2)
        self.assertIn("lower(value)", table["indexes"][0]["sql"])

    def test_protocol_sources_and_hashes(self):
        sources = self.build()["protocol_sources"]
        paths = [source["path"] for source in sources]
        self.assertEqual(paths, sorted(paths))
        for path in (*baseline.REQUIRED_PROTOCOLS, "packages/shared/live-call-wire.ts"):
            self.assertIn(path, paths)
        self.assertFalse(any(path.endswith((".test.ts", ".spec.ts")) for path in paths))
        for source in sources:
            self.assertEqual(source["sha256"], hashlib.sha256(
                (baseline.ROOT / source["path"]).read_bytes()).hexdigest())

    def test_missing_required_protocol_is_not_skipped(self):
        with self.assertRaises(OSError):
            baseline.protocol_hashes(self.root)

    def test_deterministic_across_runs_and_directory_locations(self):
        first = baseline.serialize(self.build())
        self.assertEqual(first, baseline.serialize(self.build()))
        other = self.root / "other"
        other.mkdir()
        for path in reversed(sorted(self.migrations.glob("*.sql"))):
            (other / path.name).write_bytes(path.read_bytes())
        self.assertEqual(first, baseline.serialize(baseline.build_baseline(other)))
        self.assertNotIn(str(self.root), first)
        one, two = self.cli(), self.cli()
        self.assertEqual(one.returncode, 0, one.stderr)
        self.assertEqual(two.returncode, 0, two.stderr)
        self.assertEqual(one.stdout, two.stdout)
        self.assertEqual(first, one.stdout)

    def test_schema_and_migration_drift(self):
        before = self.build()
        path = self.write_migration("0003_drift.sql", "ALTER TABLE child ADD COLUMN drift INTEGER;")
        after = self.build()
        self.assertNotEqual(before["tables"], after["tables"])
        self.assertNotEqual(before["migrations"], after["migrations"])
        path.write_text("-- only a source change\nALTER TABLE child ADD COLUMN drift INTEGER;\n",
                        encoding="utf-8")
        changed = self.build()
        self.assertEqual(after["tables"], changed["tables"])
        self.assertNotEqual(after["migrations"], changed["migrations"])

    def test_write_check_and_drift_cli(self):
        target = self.root / "baseline.json"
        written = self.cli("--write", target)
        self.assertEqual(written.returncode, 0, written.stderr)
        self.assertEqual(written.stdout, "")
        self.assertEqual(target.read_text(encoding="utf-8"), self.cli().stdout)
        checked = self.cli("--check", target)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        original = target.read_bytes()
        self.write_migration("0003_drift.sql", "CREATE TABLE drift (id INTEGER);")
        checked = self.cli("--check", target)
        self.assertNotEqual(checked.returncode, 0)
        self.assertIn("Baseline mismatch", checked.stderr)
        self.assertEqual(target.read_bytes(), original)

    def test_check_compares_json_values_and_protocol_hashes(self):
        target = self.root / "baseline.json"
        value = self.build()
        target.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
        self.assertEqual(self.cli("--check", target).returncode, 0)
        value["protocol_sources"][0]["sha256"] = "0" * 64
        target.write_text(json.dumps(value), encoding="utf-8")
        self.assertNotEqual(self.cli("--check", target).returncode, 0)

    def test_check_errors_and_mutually_exclusive_modes(self):
        target = self.root / "bad.json"
        missing = self.cli("--check", target)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn(str(target), missing.stderr)
        target.write_text("not json", encoding="utf-8")
        invalid = self.cli("--check", target)
        self.assertNotEqual(invalid.returncode, 0)
        self.assertNotIn("Traceback", invalid.stderr)
        self.assertNotEqual(self.cli("--write", target, "--check", target).returncode, 0)
        self.assertNotEqual(self.cli("--write", self.root / "missing" / "file.json").returncode, 0)

    def test_failure_names_file_and_never_writes_or_skips(self):
        bad = self.write_migration("0003_broken.sql", "CREATE TABLE broken (; ")
        self.write_migration("0004_later.sql", "CREATE TABLE later (id INTEGER);")
        with self.assertRaisesRegex(baseline.BaselineError, "0003_broken.sql"):
            self.build()
        target = self.root / "baseline.json"
        target.write_text("untouched", encoding="utf-8")
        result = self.cli("--write", target)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(bad), result.stderr)
        self.assertIn("Migration failed", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(target.read_text(encoding="utf-8"), "untouched")
        self.assertNotIn("Traceback", result.stderr)

    def test_invalid_encoding_names_migration(self):
        path = self.migrations / "0003_invalid.sql"
        path.write_bytes(b"\xff")
        result = self.cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(path), result.stderr)

    def test_missing_and_empty_migration_directories_fail(self):
        for name in ("missing", "empty"):
            path = self.root / name
            if name == "empty":
                path.mkdir()
            with self.assertRaises(baseline.BaselineError):
                baseline.build_baseline(path)
            result = self.cli("--migrations-dir", path, migrations=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(str(path), result.stderr)

    def test_migrations_cannot_attach_real_database(self):
        database = self.root / "forbidden.sqlite"
        self.write_migration("0003_attach.sql", f"ATTACH DATABASE '{database}' AS external;")
        result = self.cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("0003_attach.sql", result.stderr)
        self.assertFalse(database.exists())

    def test_schema_snapshot_detects_changes_without_migration_hashes(self):
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.row_factory = sqlite3.Row
        connection.executescript(self.first_sql)
        previous = baseline.schema_snapshot(connection)
        for sql in (
            "ALTER TABLE child ADD COLUMN drift TEXT",
            "CREATE INDEX drift_index ON child(parent_id)",
            "DROP TRIGGER child_insert",
            "CREATE TABLE references_parent (id INTEGER REFERENCES parent(id))",
        ):
            connection.executescript(sql)
            current = baseline.schema_snapshot(connection)
            self.assertNotEqual(previous, current)
            previous = current

    def test_default_paths_are_script_relative(self):
        self.assertEqual(baseline.ROOT, SCRIPT.parents[1])
        self.assertEqual(baseline.DEFAULT_MIGRATIONS,
                         SCRIPT.parents[1] / "gateway/control-plane/migrations")
        result = self.cli(migrations=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual([item["path"] for item in value["migrations"]],
                         sorted(path.name for path in baseline.DEFAULT_MIGRATIONS.glob("*.sql")))
        self.assertTrue(value["tables"])


if __name__ == "__main__":
    unittest.main()
