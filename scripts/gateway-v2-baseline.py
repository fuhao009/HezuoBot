#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MIGRATIONS = ROOT / "gateway/control-plane/migrations"
REQUIRED_PROTOCOLS = (
    "gateway/control-plane/src/task-billing.ts",
    "gateway/control-plane/src/cost-tariffs.ts",
    "gateway/control-plane/src/account-ai.ts",
    "gateway/control-plane/src/ai-gateway.ts",
    "gateway/control-plane/src/index.ts",
    "packages/shared/package-format.ts",
    "packages/shared/wire.ts",
)


class BaselineError(Exception):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def protocol_hashes(root=ROOT):
    paths = {root / name for name in REQUIRED_PROTOCOLS}
    shared = root / "packages/shared"
    paths.update(
        path for path in shared.rglob("*.ts")
        if not any(part in {"node_modules", "__tests__", "__fixtures__"}
                   or "fixture" in part for part in path.relative_to(shared).parts)
        and not path.name.endswith((".test.ts", ".spec.ts"))
    )
    return [
        {"path": path.relative_to(root).as_posix(), "sha256": sha256(path.read_bytes())}
        for path in sorted(paths, key=lambda path: path.relative_to(root).as_posix())
    ]


def quote_identifier(name):
    return '"' + name.replace('"', '""') + '"'


def rows(connection, sql):
    return [dict(row) for row in connection.execute(sql)]


def schema_snapshot(connection):
    tables = []
    for table in rows(connection, "SELECT name, sql FROM sqlite_schema "
                      "WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_' "
                      "ORDER BY name"):
        name = table["name"]
        quoted = quote_identifier(name)
        indexes = []
        for index in sorted(rows(connection, f"PRAGMA index_list({quoted})"),
                            key=lambda entry: entry["name"]):
            index.pop("seq")
            index["sql"] = connection.execute(
                "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
                (index["name"],),
            ).fetchone()[0]
            index["columns"] = rows(
                connection, f"PRAGMA index_xinfo({quote_identifier(index['name'])})"
            )
            indexes.append(index)
        tables.append({
            "name": name,
            "sql": table["sql"],
            "columns": rows(connection, f"PRAGMA table_xinfo({quoted})"),
            "fks": sorted(rows(connection, f"PRAGMA foreign_key_list({quoted})"),
                          key=lambda entry: (entry["id"], entry["seq"])),
            "indexes": indexes,
            "triggers": [dict(row) for row in connection.execute(
                "SELECT name, sql FROM sqlite_schema "
                "WHERE type = 'trigger' AND tbl_name = ? ORDER BY name", (name,),
            )],
        })
    return tables


def memory_only_authorizer(action, arg1, arg2, database, source):
    # ATTACH could turn an in-memory migration into access to a real database.
    if action == sqlite3.SQLITE_ATTACH:
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def build_baseline(migrations_dir=DEFAULT_MIGRATIONS, root=ROOT):
    directory = Path(migrations_dir)
    if not directory.is_dir():
        raise BaselineError(f"Migration directory does not exist: {directory}")
    migrations = sorted(directory.glob("*.sql"), key=lambda path: path.name)
    if not migrations:
        raise BaselineError(f"No SQL migrations found in: {directory}")
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.set_authorizer(memory_only_authorizer)
    hashes = []
    try:
        for migration in migrations:
            try:
                data = migration.read_bytes()
                connection.executescript(data.decode("utf-8"))
            except (OSError, UnicodeError, sqlite3.Error) as error:
                raise BaselineError(f"Migration failed: {migration}: {error}") from error
            hashes.append({"path": migration.name, "sha256": sha256(data)})
        return {
            "format_version": 1,
            "migrations": hashes,
            "protocol_sources": protocol_hashes(root),
            "tables": schema_snapshot(connection),
        }
    finally:
        connection.close()


def serialize(baseline):
    return json.dumps(baseline, ensure_ascii=False, sort_keys=True, indent=2) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Build or check a deterministic gateway v2 schema/protocol baseline."
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", type=Path, metavar="PATH", help="write baseline JSON")
    mode.add_argument("--check", type=Path, metavar="PATH", help="check baseline JSON")
    parser.add_argument("--migrations-dir", type=Path, default=DEFAULT_MIGRATIONS,
                        help="override the SQL migration directory")
    args = parser.parse_args(argv)
    try:
        baseline = build_baseline(args.migrations_dir)
        if args.check is not None:
            expected = json.loads(args.check.read_text(encoding="utf-8"))
            if expected != baseline:
                print(f"Baseline mismatch: {args.check}", file=sys.stderr)
                return 1
            print(f"Baseline matches: {args.check}")
        elif args.write is not None:
            args.write.write_text(serialize(baseline), encoding="utf-8")
        else:
            sys.stdout.write(serialize(baseline))
    except (BaselineError, OSError, UnicodeError, ValueError, sqlite3.Error) as error:
        print(f"gateway-v2-baseline: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
