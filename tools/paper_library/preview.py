"""Serve a fresh local view of the site using the current frontend build."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from shutil import copyfile
from tempfile import TemporaryDirectory
import json
import sys

HERE = Path(__file__).resolve().parent
DIST = HERE / 'frontend' / 'dist'
sys.path.insert(0, str(HERE.parent / 'paper_add'))
from package_site import main as package_site


class PreviewHandler(SimpleHTTPRequestHandler):
    extensions_map = SimpleHTTPRequestHandler.extensions_map | {
        '.mjs': 'text/javascript',
        '.wasm': 'application/wasm',
    }

    def send_head(self):
        del self.headers['If-Modified-Since']
        return super().send_head()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    if not (DIST / 'index.html').exists():
        raise SystemExit('Run npm --prefix tools/paper_library/frontend run build first.')
    with TemporaryDirectory(prefix='paper-library-preview-') as temp:
        site = Path(temp) / 'site'
        package_site(site)
        papers = site / 'papers'
        for file in ('index.html', 'assets/app.css', 'assets/app.js', 'classification.mjs',
                     'keywords.mjs', 'keyword-vocabulary.json'):
            copyfile(DIST / file, papers / 'add' / file)
        copyfile(DIST / 'index.html', papers / 'index.html')
        (papers / 'service-config.json').write_text(
            json.dumps({'apiBase': 'http://127.0.0.1:8787'}), encoding='utf-8')
        handler = partial(PreviewHandler, directory=site)
        with ThreadingHTTPServer(('127.0.0.1', 8000), handler) as server:
            print('Paper Library preview: http://127.0.0.1:8000/papers/', flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    main()
