"""Process web inbox requests on GitHub Actions using the same quick-add engine.

No Zotero credentials or GitHub user tokens are accepted in inbox data. The
browser uploads only the requested public paper and its optional Zotero mapping.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import ipaddress
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'engine'))
import quick_add as q


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def validate_request(request, identifier):
    if not re.fullmatch(r'[a-f0-9-]{36}', identifier, re.I) or request.get('requestId') != identifier:
        raise ValueError('The request identifier is invalid.')
    if request.get('schemaVersion') != 1 or not isinstance(request.get('metadata'), dict):
        raise ValueError('The request schema is invalid.')
    if set(request) - {'schemaVersion', 'requestId', 'metadata', 'pdf', 'zotero'}:
        raise ValueError('Unexpected fields in publication request.')
    if request.get('pdf') not in (None, 'paper.pdf'):
        raise ValueError('Only the uploaded paper.pdf may be imported.')
    meta = request['metadata']
    if set(meta) - {'title', 'date', 'category', 'source', 'method', 'keywords', 'authors', 'abstract', 'doi'}:
        raise ValueError('Unexpected paper metadata fields.')
    for name, limit in (('title', 500), ('date', 10), ('category', 160), ('source', 2000), ('method', 100)):
        if name in meta and (not isinstance(meta[name], str) or len(meta[name]) > limit):
            raise ValueError(f'Invalid {name}.')
    for name, limit, count in (('keywords', 100, 30), ('authors', 160, 1000)):
        value = meta.get(name, [])
        if not isinstance(value, list) or len(value) > count or any(not isinstance(x, str) or len(x) > limit for x in value):
            raise ValueError(f'Invalid {name}.')
    for name, limit in (('abstract', 30000), ('doi', 500)):
        if name in meta and (not isinstance(meta[name], str) or len(meta[name]) > limit):
            raise ValueError(f'Invalid {name}.')
    source = meta.get('source', '')
    if source and not q.arxiv_identity(source):
        parsed = urllib.parse.urlsplit(source)
        host = (parsed.hostname or '').lower()
        if parsed.scheme != 'https' or parsed.username or parsed.password or not host or host == 'localhost' or host.endswith(('.localhost', '.local')):
            raise ValueError('Use a public HTTPS paper URL.')
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            if not address.is_global:
                raise ValueError('Private network paper URLs are not allowed.')
    if request.get('zotero'):
        mapping = request['zotero']
        if not isinstance(mapping, dict) or set(mapping) - {'parentKey', 'attachmentKey', 'pdfSha256'}:
            raise ValueError('Invalid Zotero mapping.')
        for name in ('parentKey', 'attachmentKey'):
            if not re.fullmatch(r'[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}', mapping.get(name, '')):
                raise ValueError('Invalid Zotero item key.')
        if not re.fullmatch(r'[a-f0-9]{64}', mapping.get('pdfSha256', '')):
            raise ValueError('Invalid PDF fingerprint.')
    return request


def configure_engine(site, temporary):
    library = temporary / 'Paper Library'
    website = library / '.website'
    website.mkdir(parents=True)
    for name in ('build_catalog.py', 'catalog.html', 'catalog.css', 'catalog.js', 'base.css'):
        shutil.copyfile(HERE / 'engine' / name, website / name)
    reader_source = website / 'reader'
    reader_source.mkdir()
    shutil.copyfile(HERE / 'engine' / 'export_reader.py', reader_source / 'export_reader.py')
    rows = read(site / 'papers' / 'archive-manifest.json')
    snapshot = read(site / 'papers' / 'paper-metadata.json')
    if len(rows) != len(snapshot['records']):
        raise ValueError('The published manifest and metadata are not aligned.')
    (library / 'Archive Manifest.json').write_bytes(q.json_bytes(rows))
    (library / 'Paper Metadata.json').write_bytes(q.json_bytes(snapshot))
    (website / 'additional_metadata.json').write_text('[]\n', encoding='utf-8')
    (library / 'reader').mkdir()
    shutil.copyfile(site / 'papers/reader/papers.json', library / 'reader/papers.json')
    # Preserve existing topic summaries; the ingestion engine creates a
    # placeholder only for genuinely new topics.
    for category in {row['category'] for row in rows}:
        q.validate_category(category)
        relative = Path(*category.split('/')) / 'Reading Notes Summary.html'
        summary = site / 'papers' / relative
        if summary.is_file():
            target = library / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(summary, target)
    for name, value in {
        'HERE': website / 'quick_add', 'WEBSITE': website, 'LIBRARY': library,
        'WORKSPACE': site.parent, 'SITE': site, 'PAPERS_SITE': site / 'papers',
        'MANIFEST_PATH': library / 'Archive Manifest.json', 'METADATA_PATH': library / 'Paper Metadata.json',
        'ADDITIONAL_PATH': website / 'additional_metadata.json', 'CACHE_DIR': website / 'quick_add/cache',
        'TX_DIR': website / 'quick_add/transactions', 'LOCK_DIR': website / 'quick_add/.add.lock',
        'BUILD_SCRIPT': website / 'build_catalog.py',
        'MAX_PDF_BYTES': 50 * 1024 * 1024,
    }.items():
        setattr(q, name, value)
    q.HERE.mkdir(parents=True)


def apply_mapping(site, result, mapping):
    if not mapping:
        return
    fid = result['file_id']
    pdf = site / 'papers' / (result.get('pdf') or result.get('dest')).replace('\\', '/')
    import hashlib
    if hashlib.sha256(pdf.read_bytes()).hexdigest() != mapping['pdfSha256']:
        raise ValueError('The published PDF differs from the PDF saved in Zotero.')
    path = site / f'papers/reader/data/{fid}.json'
    record = read(path)
    existing = record.get('zotero') or {}
    if existing.get('parentKey') and existing['parentKey'] != mapping['parentKey']:
        raise ValueError('This paper is already associated with a different Zotero item. Its notes were kept.')
    association = {'libraryType': 'user', 'libraryId': 1, 'parentKey': mapping['parentKey'], 'attachmentKey': mapping['attachmentKey']}
    record['zotero'] = association
    record['pdf']['sha256'] = mapping['pdfSha256']
    record['mapping'] = {'status': 'matched', 'basis': 'Verified exact PDF from the web import'}
    # Existing public notes remain unchanged. This is not a private-note refresh.
    q.atomic_write(path, q.json_bytes(record))
    registry_path = site / 'papers/reader/papers.json'
    registry = read(registry_path)
    registry['papers'][fid]['zotero'] = association
    q.atomic_write(registry_path, q.json_bytes(registry))
    manifest_path = site / 'papers/archive-manifest.json'
    manifest = read(manifest_path)
    manifest[fid]['key'] = mapping['parentKey']
    q.atomic_write(manifest_path, q.json_bytes(manifest))


def process(site, request_path):
    identifier = request_path.parent.name
    request = validate_request(read(request_path), identifier)
    m = request['metadata']
    pdf = request_path.parent / 'paper.pdf' if request.get('pdf') else None
    if pdf and (not pdf.is_file() or pdf.stat().st_size > 50 * 1024 * 1024):
        raise ValueError('The uploaded PDF is missing or exceeds 50 MB.')
    with tempfile.TemporaryDirectory(prefix='paper-web-add-') as directory:
        configure_engine(site, Path(directory))
        source = m.get('source') or None
        result = q.add_paper(source, local_file=pdf, prepared_pdf=bool(source and pdf), title=m.get('title'), date=m.get('date'), category=m.get('category', ''), method=m.get('method') or None, keywords=m.get('keywords') or [], publish=False)
        if result['status'] in {'added', 'already_exists'}:
            apply_mapping(site, result, request.get('zotero'))
        return {'schemaVersion': 1, 'requestId': identifier, 'status': result['status'], 'fileId': result['file_id'], 'title': result.get('title'), 'pdf': result.get('pdf') or result.get('dest'), 'zoteroLinked': bool(request.get('zotero')), 'processedAt': datetime.now(timezone.utc).isoformat()}


def main():
    site = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
    if subprocess.check_output(['git', '-C', str(site), 'status', '--porcelain']).strip():
        raise ValueError('Cloud ingestion requires a clean checkout. No files were changed.')
    inbox = site / '.paper-inbox'
    results = site / '.paper-results'
    results.mkdir(exist_ok=True)
    count = 0
    for path in sorted(inbox.glob('*/request.json'))[:20]:
        identifier = path.parent.name
        if not re.fullmatch(r'[a-f0-9-]{36}', identifier, re.I):
            continue
        # Preserve the exact baseline so a malformed request cannot publish a
        # partially rebuilt catalog. Only this job's clean checkout is used.
        try:
            result = process(site, path)
        except Exception as exc:
            subprocess.run(['git', '-C', str(site), 'restore', '--worktree', '--', 'papers'], check=True)
            # New outputs are untracked; remove only files reported by Git under
            # papers, each checked against the explicitly selected site root.
            pending = subprocess.check_output(['git', '-C', str(site), 'ls-files', '--others', '--exclude-standard', '-z', '--', 'papers'])
            for relative in pending.decode().split('\0'):
                if not relative:
                    continue
                target = (site / relative).resolve()
                target.relative_to((site / 'papers').resolve())
                if target.is_file():
                    target.unlink()
            result = {'schemaVersion': 1, 'requestId': identifier, 'status': 'error', 'message': str(exc)[:400]}
        q.atomic_write(results / (identifier + '.json'), q.json_bytes(result))
        for child in path.parent.iterdir():
            if child.is_file() and child.name in {'request.json', 'paper.pdf'}:
                child.unlink()
        count += 1
        # Commit each completed request before processing the next so recovery
        # of a later request never discards an earlier successful import.
        subprocess.run(['git', '-C', str(site), 'add', '--', 'papers', '.paper-inbox', '.paper-results'], check=True)
        subprocess.run(['git', '-C', str(site), 'commit', '-m', f'Process web paper request {identifier}'], check=True)
    print(json.dumps({'processedRequests': count}))


if __name__ == '__main__':
    main()
