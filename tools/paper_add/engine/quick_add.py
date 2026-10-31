#!/usr/bin/env python3
"""Fast, transactional paper ingestion for the local Paper Library.

This module deliberately avoids Zotero, citation crawling, repository discovery,
PDF rendering, and the full prepare_pages.py export.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import html
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
WEBSITE = HERE.parent
LIBRARY = WEBSITE.parent
WORKSPACE = LIBRARY.parent
SITE = WORKSPACE / "Personal Homepage"
PAPERS_SITE = SITE / "papers"
MANIFEST_PATH = LIBRARY / "Archive Manifest.json"
METADATA_PATH = LIBRARY / "Paper Metadata.json"
ADDITIONAL_PATH = WEBSITE / "additional_metadata.json"
CACHE_DIR = HERE / "cache"
TX_DIR = HERE / "transactions"
LOCK_DIR = HERE / ".add.lock"
BUILD_SCRIPT = WEBSITE / "build_catalog.py"
PUBLISH_SCRIPT = WORKSPACE / "Publish Homepage.ps1"
MAX_PDF_BYTES = 100 * 1024 * 1024
ARXIV_ID_PATTERN = r"\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?/\d{7}"
BAD_WINDOWS = re.compile(r"[<>:\"\\|?*\x00-\x1f]")
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


class QuickAddError(RuntimeError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists() and default is not None:
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)
        raise


def categories() -> list[str]:
    manifest = read_json(MANIFEST_PATH, [])
    return sorted({str(row["category"]) for row in manifest}, key=str.casefold)


def arxiv_identity(value: str) -> tuple[str, str | None] | None:
    value = urllib.parse.unquote(value.strip())
    bare = re.fullmatch(rf"(?i)(?:arxiv\s*:\s*)?({ARXIV_ID_PATTERN})(v\d+)?", value)
    if bare:
        return bare.group(1).lower(), bare.group(2).lower() if bare.group(2) else None
    parsed = urllib.parse.urlsplit(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme.lower() not in {"http", "https"} or host not in {"arxiv.org", "www.arxiv.org", "export.arxiv.org"}:
        return None
    path_match = re.fullmatch(rf"(?i)/(?:abs|pdf|html)/({ARXIV_ID_PATTERN})(v\d+)?(?:\.pdf)?/?", parsed.path)
    if not path_match:
        return None
    return path_match.group(1).lower(), path_match.group(2).lower() if path_match.group(2) else None


def normalize_source(value: str) -> str:
    identity = arxiv_identity(value)
    if identity:
        return "arxiv:" + identity[0]
    parsed = urllib.parse.urlsplit(value.strip())
    if parsed.scheme in {"http", "https"}:
        return urllib.parse.urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, parsed.query, ""))
    return value.strip()


def find_duplicate(source: str) -> dict[str, Any] | None:
    identity = arxiv_identity(source)
    manifest = read_json(MANIFEST_PATH, [])
    snapshot = read_json(METADATA_PATH, {"records": []})
    by_id = {int(row["file_id"]): row for row in snapshot.get("records", [])}
    for file_id, item in enumerate(manifest):
        record = by_id.get(file_id, {})
        if identity and str(record.get("arxiv_id") or "").lower() == identity[0]:
            return {"file_id": file_id, "title": record.get("title") or item.get("title"), "dest": item.get("dest")}
        if normalize_source(str(item.get("source") or "")) == normalize_source(source):
            return {"file_id": file_id, "title": record.get("title") or item.get("title"), "dest": item.get("dest")}
    return None


def find_pdf_duplicate(pdf_sha256: str, records: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
    """Compare only fingerprints already recorded by quick add; never read old PDFs."""
    if records is None:
        records = read_json(METADATA_PATH, {"records": []}).get("records", [])
    for record in records:
        if record.get("pdf_sha256") == pdf_sha256:
            return {
                "file_id": int(record["file_id"]),
                "title": record.get("title"),
                "dest": record.get("dest"),
            }
    return None


def request(url: str, timeout: float = 35.0) -> urllib.response.addinfourl:
    headers = {"User-Agent": "PaperLibraryQuickAdd/1.0 (personal research library)"}
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)


def cache_path(source: str) -> Path:
    identity = arxiv_identity(source)
    # Preserve a specifically requested vN in the cache key. Versions are ignored
    # for duplicate detection, but never for metadata/PDF selection.
    cache_key = f"arxiv:{identity[0]}{identity[1] or ':latest'}" if identity else normalize_source(source)
    return CACHE_DIR / (hashlib.sha256(cache_key.encode("utf-8")).hexdigest() + ".json")


def fetch_arxiv(source: str) -> dict[str, Any]:
    identity = arxiv_identity(source)
    if not identity:
        raise QuickAddError("Not a recognized arXiv ID or URL.")
    arxiv_id, requested_version = identity
    url = "https://export.arxiv.org/api/query?id_list=" + urllib.parse.quote(arxiv_id)
    try:
        with request(url) as response:
            payload = response.read(2 * 1024 * 1024)
    except (OSError, urllib.error.URLError) as exc:
        raise QuickAddError(f"Could not fetch arXiv metadata: {exc}") from exc
    try:
        root = ET.fromstring(payload)
        ns = {"a": "http://www.w3.org/2005/Atom"}
        entry = root.find("a:entry", ns)
        if entry is None:
            raise ValueError("paper not found")
        title = " ".join((entry.findtext("a:title", "", ns)).split())
        abstract = " ".join((entry.findtext("a:summary", "", ns)).split())
        published = entry.findtext("a:published", "", ns)[:10]
        authors = [" ".join((node.findtext("a:name", "", ns)).split()) for node in entry.findall("a:author", ns)]
        if not title or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", published):
            raise ValueError("incomplete metadata")
    except (ET.ParseError, ValueError) as exc:
        raise QuickAddError(f"arXiv returned invalid metadata: {exc}") from exc
    suffix = requested_version or ""
    return {
        "kind": "arxiv",
        "source": source,
        "arxiv_id": arxiv_id,
        "arxiv_version": requested_version,
        "title": title,
        "abstract": abstract,
        "summary": abstract,
        "publication_date": published,
        "authors": authors,
        "paper_url": f"https://arxiv.org/abs/{arxiv_id}{suffix}",
        "pdf_url": f"https://arxiv.org/pdf/{arxiv_id}{suffix}.pdf",
    }


def inspect_source(source: str, *, refresh: bool = False) -> dict[str, Any]:
    duplicate = find_duplicate(source)
    if duplicate:
        return {"status": "already_exists", **duplicate, "categories": categories(), "network_used": False}
    path = cache_path(source)
    if path.exists() and not refresh:
        result = read_json(path)
        # Caches made by the initial quick-add version did not include summaries.
        if result.get("kind") != "arxiv" or "abstract" in result:
            result.update({"status": "ok", "cached": True, "categories": categories()})
            return result
    if arxiv_identity(source):
        result = fetch_arxiv(source)
    else:
        parsed = urllib.parse.urlsplit(source)
        if parsed.scheme not in {"http", "https"}:
            raise QuickAddError("Use an arXiv ID, an http(s) PDF URL, or add with --file.")
        result = {
            "kind": "generic_pdf",
            "source": source,
            "title": None,
            "publication_date": None,
            "paper_url": source,
            "pdf_url": source,
            "arxiv_id": None,
            "arxiv_version": None,
            "authors": [],
            "abstract": None,
            "summary": None,
            "needs_manual": ["title", "date"],
        }
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    atomic_write(path, json_bytes(result))
    return {"status": "ok", **result, "cached": False, "categories": categories()}


def valid_pdf(path: Path) -> None:
    size = path.stat().st_size
    if size < 8 or size > MAX_PDF_BYTES:
        raise QuickAddError("The PDF is empty, truncated, or over the 100 MB limit.")
    with path.open("rb") as stream:
        if stream.read(5) != b"%PDF-":
            raise QuickAddError("The downloaded/uploaded file is not a valid PDF.")


def download_pdf(url: str, destination: Path) -> None:
    written = 0
    try:
        with request(url, timeout=60.0) as response, destination.open("wb") as output:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                written += len(block)
                if written > MAX_PDF_BYTES:
                    raise QuickAddError("The PDF exceeds the 100 MB limit.")
                output.write(block)
    except (OSError, urllib.error.URLError) as exc:
        raise QuickAddError(f"Could not download the PDF: {exc}") from exc
    valid_pdf(destination)


def clean_component(value: str, label: str) -> str:
    value = unicodedata.normalize("NFC", value.strip())
    if not value or value in {".", ".."} or BAD_WINDOWS.search(value) or value.endswith((" ", ".")):
        raise QuickAddError(f"Invalid {label}.")
    if value.upper().split(".")[0] in RESERVED:
        raise QuickAddError(f"Invalid reserved Windows name in {label}.")
    return value


def validate_category(value: str) -> str:
    value = value.strip().replace("\\", "/")
    parts = value.split("/")
    if len(parts) < 2 or any(not part for part in parts):
        raise QuickAddError("Category must contain at least Area/Topic.")
    return "/".join(clean_component(part, "category") for part in parts)


def clean_method(value: str | None, title: str) -> str:
    candidate = (value or title.split(":", 1)[0]).strip()
    candidate = re.sub(r"\s+", " ", candidate)
    candidate = BAD_WINDOWS.sub("-", candidate).strip(" .-")
    if not candidate:
        raise QuickAddError("A method short name is required.")
    if len(candidate) > 90:
        candidate = candidate[:90].rstrip(" .-")
    return clean_component(candidate, "method short name")


def parse_date(value: str) -> str:
    value = value.strip()
    if not re.fullmatch(r"\d{4}-\d{2}(?:-\d{2})?", value):
        raise QuickAddError("Date must be YYYY-MM or YYYY-MM-DD.")
    try:
        datetime.strptime(value, "%Y-%m-%d" if len(value) == 10 else "%Y-%m")
    except ValueError as exc:
        raise QuickAddError("Date is not a real calendar date.") from exc
    return value


def parse_keywords(value: str | list[str] | None) -> list[str]:
    if isinstance(value, list):
        raw = value
    else:
        raw = re.split(r"[,;]", value or "")
    result: list[str] = []
    seen: set[str] = set()
    for item in raw:
        item = " ".join(str(item).strip().split())
        if item and item.casefold() not in seen:
            if len(item) > 80:
                raise QuickAddError("Each keyword must be at most 80 characters.")
            seen.add(item.casefold())
            result.append(item)
    return result


@contextlib.contextmanager
def library_lock(timeout: float = 30.0):
    """Cross-process lock released automatically by the OS after a crash."""
    LOCK_DIR.parent.mkdir(parents=True, exist_ok=True)
    stream = LOCK_DIR.open("a+b")
    stream.seek(0, os.SEEK_END)
    if stream.tell() == 0:
        stream.write(b"\0")
        stream.flush()
    deadline = time.monotonic() + timeout
    locked = False
    try:
        while not locked:
            try:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
            except OSError:
                if time.monotonic() >= deadline:
                    raise QuickAddError("Another paper add is still running; try again shortly.")
                time.sleep(0.08)
        yield
    finally:
        if locked:
            with contextlib.suppress(OSError):
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


def _allowed_target(path: Path) -> bool:
    resolved = path.resolve()
    return resolved == LIBRARY.resolve() or LIBRARY.resolve() in resolved.parents or resolved == SITE.resolve() or SITE.resolve() in resolved.parents


def recover_incomplete() -> None:
    if not TX_DIR.exists():
        return
    for log_path in TX_DIR.glob("*.json"):
        try:
            log = read_json(log_path)
            if log.get("status") != "applying":
                continue
            for entry in reversed(log.get("targets", [])):
                target = Path(entry["target"])
                if not _allowed_target(target):
                    continue
                backup = Path(entry["backup"]) if entry.get("backup") else None
                if backup and backup.exists():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(backup, target)
                elif entry.get("created"):
                    with contextlib.suppress(FileNotFoundError):
                        target.unlink()
            log["status"] = "recovered_rollback"
            log["recovered_at"] = now()
            atomic_write(log_path, json_bytes(log))
            shutil.rmtree(log_path.with_suffix(""), ignore_errors=True)
        except Exception:
            # Leave the log and backups intact for manual diagnosis.
            continue


class Transaction:
    def __init__(self, targets: list[Path]):
        self.txid = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
        self.backup_dir = TX_DIR / self.txid
        self.log_path = TX_DIR / (self.txid + ".json")
        self.targets = list(dict.fromkeys(path.resolve() for path in targets))
        self.log: dict[str, Any] = {"transaction_id": self.txid, "status": "preparing", "started_at": now(), "targets": []}

    def begin(self) -> None:
        TX_DIR.mkdir(parents=True, exist_ok=True)
        self.backup_dir.mkdir()
        for index, target in enumerate(self.targets):
            if not _allowed_target(target):
                raise QuickAddError(f"Unsafe transaction target: {target}")
            entry: dict[str, Any] = {"target": str(target), "created": not target.exists(), "backup": None}
            if target.is_file():
                backup = self.backup_dir / f"{index}.bak"
                shutil.copy2(target, backup)
                entry["backup"] = str(backup)
            self.log["targets"].append(entry)
        self.log["status"] = "applying"
        atomic_write(self.log_path, json_bytes(self.log))

    def commit(self) -> None:
        self.log["status"] = "committed"
        self.log["finished_at"] = now()
        atomic_write(self.log_path, json_bytes(self.log))
        shutil.rmtree(self.backup_dir, ignore_errors=True)

    def rollback(self, error: BaseException) -> None:
        for entry in reversed(self.log.get("targets", [])):
            target = Path(entry["target"])
            backup = Path(entry["backup"]) if entry.get("backup") else None
            if backup and backup.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(backup, target)
            elif entry.get("created"):
                with contextlib.suppress(FileNotFoundError):
                    target.unlink()
        self.log["status"] = "rolled_back"
        self.log["finished_at"] = now()
        self.log["error"] = str(error)
        atomic_write(self.log_path, json_bytes(self.log))
        shutil.rmtree(self.backup_dir, ignore_errors=True)


def placeholder_summary(category: str) -> bytes:
    escaped = html.escape(category)
    document = f'''<!doctype html><html lang="en"><meta charset="utf-8"><title>Reading Notes</title>
<style>body{{max-width:900px;margin:3em auto;padding:0 1em;line-height:1.7;font-family:system-ui}}.notice{{padding:16px;border:1px dashed #c7d3c9;color:#606c68}}</style>
<h1>{escaped} — Reading Notes</h1>
<p class="notice">No personal reading notes have been added for papers in this topic.</p>\n'''
    return document.encode("utf-8")


def public_catalog_html(source: str) -> str:
    source = source.replace('<span class="local-label">Personal collection</span>', '<a class="home-link" href="../index.html">← Home</a>')
    source = source.replace("Some files may have notes in Zotero that are not linked here. Images and internal links in exported notes may require Zotero.", "Some files may have notes in Zotero that are not linked here. Available note images are included; missing images are marked in the notes.")
    source = source.replace("</style>", ".zotero-link{display:none}.home-link{font-size:12px;text-decoration:none;white-space:nowrap;margin-top:8px}</style>", 1)
    return source


def public_manifest(rows: list[dict[str, Any]], records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Portable, public fields only; never publish original local source paths."""
    metadata = {int(row['file_id']): row for row in records}
    result = []
    for fid, row in enumerate(rows):
        meta = metadata.get(fid, {})
        source = meta.get('paper_url') or ''
        if not isinstance(source, str) or not source.startswith(('https://', 'http://')):
            source = ''
        result.append({
            'source': source, 'dest': str(row['dest']).replace('\\', '/'),
            'category': row['category'], 'title': row.get('title') or meta.get('title') or '',
            'key': row.get('key'), 'method': 'Paper Library import',
            'notes': row.get('notes', 0), 'note': str(row.get('note') or '').replace('\\', '/'),
            'year': row.get('year') or str(meta.get('publication_date') or '')[:4],
        })
    return result


def reader_export_for_add(file_id: int) -> tuple[Any, list[Path]]:
    """Reserve the installed reader's offline outputs before the transaction."""
    module_path = WEBSITE / "reader" / "export_reader.py"
    if not module_path.is_file():
        return None, []
    spec = importlib.util.spec_from_file_location("_paper_library_reader_export", module_path)
    if spec is None or spec.loader is None:
        raise QuickAddError("The reader exporter could not be loaded.")
    exporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(exporter)
    expected = [
        LIBRARY / "reader" / "papers.json",
        LIBRARY / "reader" / "data" / f"{file_id}.json",
        PAPERS_SITE / "reader" / "papers.json",
        PAPERS_SITE / "reader" / "data" / f"{file_id}.json",
    ]
    planned = [Path(path).resolve() for path in exporter.reader_record_paths(file_id, library=LIBRARY, site=SITE)]
    if len(planned) != 4 or set(planned) != {path.resolve() for path in expected}:
        raise QuickAddError("The reader exporter returned an unexpected file list.")
    return exporter, expected


def verify_state(file_id: int, library_pdf: Path, site_pdf: Path, title: str) -> None:
    manifest = read_json(MANIFEST_PATH)
    snapshot = read_json(METADATA_PATH)
    additional = read_json(ADDITIONAL_PATH, [])
    records = snapshot.get("records", [])
    if len(manifest) != len(records) or any(int(row.get("file_id", -1)) != i for i, row in enumerate(records)):
        raise QuickAddError("Manifest and metadata IDs are not aligned.")
    if file_id != len(manifest) - 1 or int(additional[-1]["file_id"]) != file_id:
        raise QuickAddError("The new stable file ID was not persisted correctly.")
    valid_pdf(library_pdf)
    valid_pdf(site_pdf)
    if hashlib.sha256(library_pdf.read_bytes()).digest() != hashlib.sha256(site_pdf.read_bytes()).digest():
        raise QuickAddError("The public PDF copy does not match the library PDF.")
    if html.escape(title, quote=True) not in (LIBRARY / "index.html").read_text(encoding="utf-8"):
        raise QuickAddError("The rebuilt catalog does not contain the new title.")


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    command = ["git", "-c", f"safe.directory={SITE.as_posix()}", "-C", str(SITE), *args]
    return subprocess.run(command, text=True, encoding="utf-8", errors="replace", capture_output=True, check=check)


def publish_preflight() -> None:
    staged = [line for line in git("diff", "--cached", "--name-only").stdout.splitlines() if line.strip()]
    if staged:
        raise QuickAddError("Publishing stopped because the homepage repository already has staged changes.")
    common = git("status", "--porcelain", "--untracked-files=all", "--", "papers/index.html", "papers/paper-metadata.json", "papers/reader/papers.json").stdout.strip()
    if common:
        raise QuickAddError("Publishing stopped because a previous local paper batch is still pending in the public catalog. Publish or commit that batch first.")
    ahead = git("rev-list", "--count", "origin/main..HEAD", check=False)
    if ahead.returncode:
        raise QuickAddError("Publishing stopped because the local branch could not be compared with origin/main.")
    try:
        count = int(ahead.stdout.strip())
    except ValueError as exc:
        raise QuickAddError("Publishing stopped because Git returned an invalid branch comparison.") from exc
    if count:
        raise QuickAddError(f"Publishing stopped because {count} pre-existing local commit(s) would also be pushed.")


def publish_changes(paths: list[Path], title: str) -> dict[str, Any]:
    staged = [line for line in git("diff", "--cached", "--name-only").stdout.splitlines() if line.strip()]
    if staged:
        raise QuickAddError("Publishing stopped because the homepage repository already has staged changes.")
    relatives = [path.resolve().relative_to(SITE.resolve()).as_posix() for path in paths]
    git("add", "--", *relatives)
    staged_after = [line for line in git("diff", "--cached", "--name-only").stdout.splitlines() if line.strip()]
    if set(staged_after) != set(relatives):
        git("restore", "--staged", "--", *relatives, check=False)
        raise QuickAddError("Publishing stopped because Git staging was not limited to this paper's files.")
    try:
        git("commit", "-m", f"Add {title} to paper library", "--", *relatives)
    except subprocess.CalledProcessError as exc:
        git("restore", "--staged", "--", *relatives, check=False)
        raise QuickAddError("Git could not create the paper-only commit: " + (exc.stderr or exc.stdout).strip()) from exc
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(PUBLISH_SCRIPT)],
        cwd=WORKSPACE,
        text=True,
        capture_output=True,
    )
    if completed.returncode:
        return {
            "committed": True,
            "pushed": False,
            "published": False,
            "deployment_status": "not_checked",
            "publish_error": "The commit was created, but the Git push failed: " + (completed.stderr or completed.stdout).strip(),
        }
    return {"committed": True, "pushed": True, "published": False, "deployment_status": "not_checked"}


def add_paper(
    source: str | None,
    *,
    category: str,
    keywords: str | list[str] | None = None,
    method: str | None = None,
    title: str | None = None,
    date: str | None = None,
    local_file: Path | None = None,
    publish: bool = False,
    code_status: str = "unverified",
    code_source: str | None = None,
    repository_url: str | None = None,
    code_license: str | None = None,
    prepared_pdf: bool = False,
) -> dict[str, Any]:
    started = time.monotonic()
    source = (source or "").strip()
    if not source and not local_file:
        raise QuickAddError("Provide an arXiv ID/PDF URL or a local PDF.")
    if source and local_file and not prepared_pdf:
        raise QuickAddError("Use either a source URL/ID or a local PDF, not both.")
    if prepared_pdf and not (source and local_file):
        raise QuickAddError('A prepared PDF requires both its source URL and local file.')
    duplicate = find_duplicate(source) if source else None
    if duplicate:
        return {"status": "already_exists", **duplicate, "published": False, "pushed": False, "deployment_status": "not_checked", "elapsed_seconds": round(time.monotonic() - started, 3)}
    category = validate_category(category)
    if code_status not in {"unverified", "open", "public", "restricted", "resources", "not_released", "not_found"}:
        raise QuickAddError("Unsupported code status.")
    if code_status != "unverified" and not code_source:
        raise QuickAddError("A verified code status requires --code-source.")
    if code_status == "unverified" and code_license:
        raise QuickAddError("A verified license requires a checked code status and source.")
    if code_status in {"open", "public", "restricted"} and not repository_url:
        raise QuickAddError("Available code requires --repository-url.")
    if code_status == "open" and not (code_license and code_license.strip()):
        raise QuickAddError("Open-source status requires a verified --code-license.")
    if publish:
        # Do this before metadata/PDF network work and before any library writes.
        publish_preflight()
    inspection: dict[str, Any]
    if source:
        inspection = inspect_source(source)
        if inspection.get("status") == "already_exists":
            return {**inspection, "published": False, "pushed": False, "deployment_status": "not_checked", "elapsed_seconds": round(time.monotonic() - started, 3)}
    else:
        inspection = {"kind": "local_pdf", "authors": [], "arxiv_id": None, "arxiv_version": None, "paper_url": None, "pdf_url": None}
    final_title = " ".join((title or inspection.get("title") or "").split())
    final_date = parse_date(date or inspection.get("publication_date") or "")
    if not final_title:
        raise QuickAddError("Title is required for this PDF.")
    if len(final_title) > 500:
        raise QuickAddError("Title is too long.")
    short = clean_method(method, final_title)
    tags = parse_keywords(keywords)
    temp_root = Path(tempfile.mkdtemp(prefix="quick-add-", dir=HERE))
    staged_pdf = temp_root / "paper.pdf"
    try:
        if local_file:
            local_file = Path(local_file).resolve()
            if not local_file.is_file():
                raise QuickAddError("The local PDF does not exist.")
            if local_file.stat().st_size > MAX_PDF_BYTES:
                raise QuickAddError("The PDF exceeds the 100 MB limit.")
            shutil.copyfile(local_file, staged_pdf)
            valid_pdf(staged_pdf)
        else:
            download_pdf(str(inspection["pdf_url"]), staged_pdf)
        pdf_sha256 = hashlib.sha256(staged_pdf.read_bytes()).hexdigest()

        with library_lock():
            recover_incomplete()
            if publish:
                # Recheck while holding the same lock through commit/push. This
                # closes the race between two concurrent quick-add processes.
                publish_preflight()
            duplicate = find_duplicate(source) if source else None
            if duplicate:
                return {"status": "already_exists", **duplicate, "published": False, "pushed": False, "deployment_status": "not_checked", "elapsed_seconds": round(time.monotonic() - started, 3)}
            manifest = read_json(MANIFEST_PATH)
            snapshot = read_json(METADATA_PATH)
            additional = read_json(ADDITIONAL_PATH, [])
            records = snapshot.get("records", [])
            if len(manifest) != len(records) or any(int(row.get("file_id", -1)) != i for i, row in enumerate(records)):
                raise QuickAddError("Existing manifest/metadata alignment is invalid; no files were changed.")
            fingerprint_duplicate = find_pdf_duplicate(pdf_sha256, records)
            if fingerprint_duplicate:
                return {
                    "status": "already_exists",
                    **fingerprint_duplicate,
                    "duplicate_basis": "pdf_sha256",
                    "published": False,
                    "pushed": False,
                    "deployment_status": "not_checked",
                    "elapsed_seconds": round(time.monotonic() - started, 3),
                }
            file_id = len(manifest)
            prefix = final_date[:7]
            dest = Path(*category.split("/")) / f"{prefix} - {short}.pdf"
            existing_dest = {str(row["dest"]).replace("/", "\\").casefold() for row in manifest}
            suffix = inspection.get("arxiv_id") or hashlib.sha256((source or final_title).encode()).hexdigest()[:8]
            candidate_number = 0
            while (
                str(dest).casefold() in existing_dest
                or (LIBRARY / dest).exists()
                or (PAPERS_SITE / dest).exists()
            ):
                candidate_number += 1
                extra = str(suffix) if candidate_number == 1 else f"{suffix}-{candidate_number}"
                dest = Path(*category.split("/")) / f"{prefix} - {short} {extra}.pdf"
            dest_text = str(dest)
            timestamp = now()
            precision = "day" if len(final_date) == 10 else "month"
            is_arxiv = inspection.get("kind") == "arxiv"
            version = inspection.get("arxiv_version")
            paper_url = inspection.get("paper_url") or (source if source else None)
            code_checked = timestamp if code_status != "unverified" else None
            source_date = inspection.get("publication_date") or ""
            source_backed_date = is_arxiv and (
                not date
                or final_date == source_date
                or (len(final_date) == 7 and source_date.startswith(final_date + "-"))
            )
            record = {
                "file_id": file_id,
                "dest": dest_text,
                "title": final_title,
                "arxiv_id": inspection.get("arxiv_id"),
                "arxiv_version": version,
                "paper_url": paper_url,
                "publication_date": final_date,
                "date_precision": precision,
                "date_basis": (f"arXiv first submission{f' ({version})' if version else ''}" if source_backed_date else "User-provided publication date"),
                "date_source": paper_url if source_backed_date else None,
                "date_checked_at": timestamp if source_backed_date else None,
                "citation_count": None,
                "citation_source": "Semantic Scholar",
                "citation_url": None,
                "citations_checked_at": None,
                "kind": "paper",
                "metadata_checked_at": timestamp,
                "keywords": tags,
                "keywords_source": "User-provided during quick add" if tags else "No editorial keywords provided during quick add",
                "code_status": code_status,
                "code_available": code_status in {"open", "public", "restricted"},
                "repository_kind": "implementation" if repository_url else None,
                "repository": None,
                "repository_url": repository_url,
                "repository_stars": None,
                "repository_license": code_license.strip() if code_license else None,
                "license_note": None,
                "code_note": "User supplied a checked code status and source during quick add." if code_checked else "Code status was not checked during quick add.",
                "code_source": code_source,
                "code_checked_at": code_checked,
                "stars_checked_at": None,
                "code_project_url": None,
                "authors": inspection.get("authors") or [],
                "pdf_sha256": pdf_sha256,
            }
            manifest_row = {
                "source": source or "Local PDF upload",
                "dest": dest_text,
                "category": category,
                "title": final_title,
                "key": None,
                "method": "Quick add; no personal reading notes created",
                "notes": 0,
                "note": "",
                "year": final_date[:4],
            }
            manifest.append(manifest_row)
            records.append(record)
            additional.append(record)
            snapshot["checked_at"] = timestamp
            snapshot["records"] = records
            library_pdf = LIBRARY / dest
            site_pdf = PAPERS_SITE / dest
            topic_summary = LIBRARY / Path(*category.split("/")) / "Reading Notes Summary.html"
            site_summary = PAPERS_SITE / Path(*category.split("/")) / "Reading Notes Summary.html"
            new_summary = not topic_summary.exists()
            site_paths = [site_pdf, PAPERS_SITE / "index.html", PAPERS_SITE / "paper-metadata.json", PAPERS_SITE / "archive-manifest.json"]
            reader_exporter, reader_paths = reader_export_for_add(file_id)
            site_paths.extend(path for path in reader_paths if PAPERS_SITE.resolve() in path.resolve().parents)
            if new_summary:
                site_paths.append(site_summary)
            targets = [MANIFEST_PATH, METADATA_PATH, ADDITIONAL_PATH, LIBRARY / "index.html", library_pdf, *site_paths]
            targets.extend(reader_paths)
            if new_summary:
                targets.append(topic_summary)
            tx = Transaction(targets)
            tx.begin()
            try:
                atomic_write(MANIFEST_PATH, json_bytes(manifest))
                atomic_write(METADATA_PATH, json_bytes(snapshot))
                atomic_write(ADDITIONAL_PATH, json_bytes(additional))
                library_pdf.parent.mkdir(parents=True, exist_ok=True)
                atomic_write(library_pdf, staged_pdf.read_bytes())
                if new_summary:
                    atomic_write(topic_summary, placeholder_summary(category))
                built = subprocess.run([sys.executable, str(BUILD_SCRIPT)], cwd=WEBSITE, text=True, capture_output=True)
                if built.returncode:
                    raise QuickAddError("Catalog build failed: " + (built.stderr or built.stdout).strip())
                site_pdf.parent.mkdir(parents=True, exist_ok=True)
                atomic_write(site_pdf, staged_pdf.read_bytes())
                if new_summary:
                    atomic_write(site_summary, topic_summary.read_bytes())
                atomic_write(PAPERS_SITE / "index.html", public_catalog_html((LIBRARY / "index.html").read_text(encoding="utf-8")).encode("utf-8"))
                atomic_write(PAPERS_SITE / "paper-metadata.json", METADATA_PATH.read_bytes())
                atomic_write(PAPERS_SITE / "archive-manifest.json", json_bytes(public_manifest(manifest, records)))
                if reader_exporter is not None:
                    written = reader_exporter.ensure_reader_record(file_id, library=LIBRARY, site=SITE)
                    if {Path(path).resolve() for path in written} != {path.resolve() for path in reader_paths}:
                        raise QuickAddError("The reader exporter wrote an unexpected file list.")
                    if any(not path.is_file() for path in reader_paths):
                        raise QuickAddError("The reader export is incomplete.")
                fail_point = os.environ.get("QUICK_ADD_FAIL_AFTER")
                if fail_point == "export":
                    raise OSError("Injected export failure")
                verify_state(file_id, library_pdf, site_pdf, final_title)
                tx.commit()
            except BaseException as exc:
                tx.rollback(exc)
                raise

            publication = {"committed": False, "pushed": False, "published": False, "deployment_status": "not_checked"}
            if publish:
                publication = publish_changes(site_paths, final_title)
        exported = [str(path.relative_to(WORKSPACE)).replace("\\", "/") for path in site_paths]
        return {
            "status": "added",
            "file_id": file_id,
            "title": final_title,
            "category": category,
            "pdf": dest_text.replace("\\", "/"),
            "exported_files": exported,
            **publication,
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Fast paper ingestion without a full Zotero export.")
    sub = root.add_subparsers(dest="command", required=True)
    sub.add_parser("categories", help="List existing Area/Topic categories (offline).")
    inspect_parser = sub.add_parser("inspect", help="Inspect and cache source metadata.")
    inspect_parser.add_argument("source")
    inspect_parser.add_argument("--refresh", action="store_true")
    add = sub.add_parser("add", help="Add one paper transactionally.")
    add.add_argument("source", nargs="?", help="arXiv ID/URL or generic PDF URL")
    add.add_argument("--file", type=Path, help="Local PDF (CLI only; title/date required)")
    add.add_argument("--category", required=True, help="Area/Topic")
    add.add_argument("--keywords", default="", help="Comma-separated editorial keywords")
    add.add_argument("--method", help="Short method name used in the filename")
    add.add_argument("--title", help="Required for generic/local PDFs")
    add.add_argument("--date", help="YYYY-MM or YYYY-MM-DD; required for generic/local PDFs")
    add.add_argument("--publish", action="store_true", help="Commit only this paper's public files and push; does not wait for Pages deployment")
    add.add_argument("--code-status", default="unverified", choices=["unverified", "open", "public", "restricted", "resources", "not_released", "not_found"])
    add.add_argument("--code-source", help="Required when supplying a checked code status")
    add.add_argument("--repository-url")
    add.add_argument("--code-license", help="Verified repository license identifier or name")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "categories":
            result: Any = {"status": "ok", "categories": categories()}
        elif args.command == "inspect":
            result = inspect_source(args.source, refresh=args.refresh)
        else:
            if args.file and args.source:
                raise QuickAddError("Use either a source URL/ID or --file, not both.")
            result = add_paper(
                args.source,
                category=args.category,
                keywords=args.keywords,
                method=args.method,
                title=args.title,
                date=args.date,
                local_file=args.file,
                publish=args.publish,
                code_status=args.code_status,
                code_source=args.code_source,
                repository_url=args.repository_url,
                code_license=args.code_license,
            )
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (QuickAddError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
