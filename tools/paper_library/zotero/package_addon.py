"""Build the Zotero XPI and its update manifest from the tracked add-on source."""
import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

HERE = Path(__file__).resolve().parent
SOURCE = HERE / 'zotero-addon'
BASE_URL = 'https://yak9ce3teeh.github.io/papers/add/'
FILES = ('manifest.json', 'bootstrap.js', 'core.js', 'translation.js', 'bridge.js')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', action='store_true', help='Write artifacts to papers/add.')
    target = HERE.parents[2] / 'papers' / 'add' if parser.parse_args().release else HERE / 'dist'
    target.mkdir(parents=True, exist_ok=True)
    archive_path = target / 'paper-library-web.xpi'
    with ZipFile(archive_path, 'w') as archive:
        for file in FILES:
            archive.writestr(ZipInfo(file), (SOURCE / file).read_bytes(), compress_type=ZIP_DEFLATED)
    manifest = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8'))
    zotero = manifest['applications']['zotero']
    update = {
        'version': manifest['version'],
        'update_link': BASE_URL + archive_path.name,
        'update_hash': 'sha256:' + hashlib.sha256(archive_path.read_bytes()).hexdigest(),
        'applications': {'zotero': {name: zotero[name] for name in ('strict_min_version', 'strict_max_version')}},
    }
    metadata = {'addons': {zotero['id']: {'updates': [update]}}}
    (target / 'updates.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(archive_path)


if __name__ == '__main__':
    main()
