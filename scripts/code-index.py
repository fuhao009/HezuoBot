#!/usr/bin/env python3
"""Build and search a local, offline source-text index."""
import argparse
import json
import sqlite3
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATABASE = ROOT / '.hezuo-scratch' / 'code-index.sqlite'
SUFFIXES = {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.sql', '.swift', '.kt', '.kts', '.py', '.sh', '.yml', '.yaml', '.html', '.css', '.toml'}
EXCLUDED = {'node_modules', '.git', 'third_party', 'references', 'release', 'dist', 'dist-server', 'dist-native', 'dist-companion', '.hezuo-scratch', '.gradle', '.build', 'build'}


def build():
    paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DATABASE) as db:
        db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS source USING fts5(path UNINDEXED, first_line UNINDEXED, text, tokenize="unicode61 tokenchars _")')
        db.execute('DELETE FROM source')
        files = chunks = 0
        for name in sorted(set(paths)):
            path = ROOT / name
            if not name or any(part in EXCLUDED for part in Path(name).parts) or path.suffix not in SUFFIXES or path.is_symlink() or not path.is_file():
                continue
            if path.name in {'pnpm-lock.yaml', 'package-lock.json'} or path.name.startswith('.env'):
                continue
            try:
                text = path.read_text(encoding='utf-8')
            except UnicodeError:
                continue
            if '\0' in text:
                continue
            lines = text.splitlines()
            for start in range(0, len(lines), 80):
                db.execute('INSERT INTO source VALUES (?, ?, ?)', (name, start + 1, '\n'.join(lines[start:start + 80])))
                chunks += 1
            files += 1
        db.execute("INSERT INTO source(source) VALUES('optimize')")
    print(json.dumps({'database': str(DATABASE.relative_to(ROOT)), 'files': files, 'chunks': chunks}, ensure_ascii=False))


def search(query, limit):
    if not DATABASE.exists():
        raise SystemExit('Run build first.')
    with sqlite3.connect(f'file:{DATABASE}?mode=ro', uri=True) as db:
        rows = db.execute("SELECT path, first_line, snippet(source, 2, '[', ']', ' … ', 32) FROM source WHERE source MATCH ? ORDER BY rank LIMIT ?", (query, limit)).fetchall()
    for path, line, snippet in rows:
        print(f'{path}:{line}\n{snippet}\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('build')
    query = sub.add_parser('search')
    query.add_argument('query')
    query.add_argument('--limit', type=int, default=10)
    args = parser.parse_args()
    if args.command == 'build':
        build()
    else:
        search(args.query, args.limit)
