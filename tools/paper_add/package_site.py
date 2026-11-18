"""Package static public files, excluding ingestion and Git administration."""
from pathlib import Path
import shutil

ROOT = Path.cwd().resolve()
OUT = ROOT / '_site'
PAPER_FILES = {
    'index.html', 'service-config.json',
    'add/index.html', 'add/legacy.html', 'add/favicon.svg', 'add/classification.mjs',
    'add/keywords.mjs', 'add/keyword-vocabulary.json', 'add/paper-library-web.xpi',
    'add/updates.json', 'add/assets/app.js', 'add/assets/app.css',
    'add/integrations/zotero.mjs', 'add/pdfjs/legacy/pdf.mjs', 'add/pdfjs/legacy/pdf.worker.mjs',
    'reader/index.html', 'reader/reader.js', 'reader/reader.css', 'reader/cloud-translation.js',
    'reader/account-client.js', 'reader/library-accounts.js', 'reader/owner-session.js',
}


def public_paper_asset(path):
    return path in PAPER_FILES or path.startswith('reader/assets/vendor/')

EXCLUDED = {'.git', '.github', 'tools', '.paper-inbox', '.paper-results', '_site',
            '__pycache__', '.paper-library-private', '.gitignore', '.gitattributes', 'README.md'}


def main():
    if OUT.exists():
        raise RuntimeError('Use a clean build checkout; _site already exists.')
    OUT.mkdir()
    for entry in ROOT.iterdir():
        if entry.name in EXCLUDED:
            continue
        target = OUT / entry.name
        if entry.name == 'papers':
            for file in entry.rglob('*'):
                if file.is_file() and public_paper_asset(file.relative_to(entry).as_posix()):
                    output = target / file.relative_to(entry)
                    output.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(file, output)
            continue
        if entry.is_dir():
            shutil.copytree(entry, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
        else:
            shutil.copy2(entry, target)
    if not (OUT / 'index.html').is_file() or not (OUT / 'papers/add/index.html').is_file():
        raise RuntimeError('The homepage or paper form is missing.')
    print('Public homepage and paper library packaged.')


if __name__ == '__main__':
    main()
