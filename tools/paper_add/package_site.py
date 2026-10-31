"""Package static public files, excluding ingestion and Git administration."""
from pathlib import Path
import shutil

ROOT = Path.cwd().resolve()
OUT = ROOT / '_site'
EXCLUDED = {'.git', '.github', 'tools', '.paper-inbox', '.paper-results', '_site',
            '__pycache__', '.gitignore', '.gitattributes', 'README.md'}


def main():
    if OUT.exists():
        raise RuntimeError('Use a clean build checkout; _site already exists.')
    OUT.mkdir()
    for entry in ROOT.iterdir():
        if entry.name in EXCLUDED:
            continue
        target = OUT / entry.name
        if entry.is_dir():
            shutil.copytree(entry, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
        else:
            shutil.copy2(entry, target)
    if not (OUT / 'index.html').is_file() or not (OUT / 'papers/add/index.html').is_file():
        raise RuntimeError('The homepage or paper form is missing.')
    print('Public homepage and paper library packaged.')


if __name__ == '__main__':
    main()
