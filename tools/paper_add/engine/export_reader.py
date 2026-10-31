#!/usr/bin/env python3
"""Paper Library reader exporter.

Primary author: DeepSeekV4.1Flash1017

Imports Zotero annotations/notes for the papers listed in the Paper
Library archive manifest and generates the deterministic public reader
snapshot (papers.json + per-paper data JSON + vendor/static assets).

Modes:
    python export_reader.py --initial-import [--zotero-db PATH] [--dry-run]
    python export_reader.py --export-assets
    python export_reader.py --report
    python export_reader.py            (offline registry + assets refresh)

Contract highlights:
  * Never writes to the Zotero SQLite database (read-only URI + read txn).
  * Never publishes .py files, DESIGN docs, private diagnostics, etc.
  * Preserves the manifest index as the stable integer file id.
  * Exact SHA-256 attachment match between the archived PDF and a
    candidate PDF attachment of the manifest parent key.
  * Deterministic exportedAt when content is unchanged.
  * ``ensure_reader_record`` and ``reader_record_paths`` form the pure
    offline quick-add integration contract.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import html as _htmlmod
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Optional

SCHEMA_VERSION = 1

HERE = Path(__file__).resolve().parent
LIBRARY = HERE.parent.parent
SITE = LIBRARY.parent / "Personal Homepage"

SOURCE_READER = LIBRARY / "reader"
SOURCE_DATA = SOURCE_READER / "data"
SOURCE_ASSETS = SOURCE_READER / "assets"
SOURCE_PAPERS = SOURCE_READER / "papers.json"

PUBLIC_READER = SITE / "papers" / "reader"
PUBLIC_DATA = PUBLIC_READER / "data"
PUBLIC_ASSETS = PUBLIC_READER / "assets"
PUBLIC_PAPERS = PUBLIC_READER / "papers.json"

MANIFEST_PATH = LIBRARY / "Archive Manifest.json"
REPORT_PATH = HERE / "private" / "import-report.json"
HASH_CACHE_PATH = HERE / "private" / "hash-cache.json"

DEFAULT_ZOTERO_DB = Path("D:/Zotero/zotero.sqlite")
DEFAULT_ZOTERO_STORAGE = Path("D:/Zotero/storage")

STATIC_WEB_FILES = ("index.html", "reader.css", "reader.js")
VENDOR_DIRNAME = "vendor"

# Numeric -> readable annotation type names used by the installed schema.
ANNOTATION_TYPES = {
    1: "highlight",
    2: "note",
    3: "image",
    4: "ink",
    5: "underline",
    6: "text",
}

_ZOTERO_FIELD_MAP = {
    "title": "j",
    "date": "j",
    "url": "j",
    "DOI": "j",
    "abstractNote": "j",
}


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _epoch_ms_to_iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    return _dt.datetime.fromtimestamp(n / 1000.0, tz=_dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _atomic_write_bytes(target: Path, payload: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=str(target.parent))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(payload)
            fh.flush()
        try:
            os.replace(tmp, target)
        except OSError:
            shutil.copy2(tmp, target)
            tmp.unlink(missing_ok=True)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _atomic_write_json(target: Path, obj: Any) -> None:
    payload = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    _atomic_write_bytes(target, payload.encode("utf-8"))


def _atomic_copy_file(src: Path, dest: Path) -> None:
    if not src.exists():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".tmp")
    shutil.copy2(src, tmp)
    os.replace(tmp, dest)


def _sha256_file(path: Path) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _quote_path(rel: str) -> str:
    parts = re.split(r"[\\/]", rel)
    return "/".join(urllib.parse.quote(p, safe="") for p in parts if p not in ("", "."))


def _relative_from_reader(pdf_path: Path, library: Path = LIBRARY) -> str:
    try:
        rel = pdf_path.resolve().relative_to(Path(library).resolve())
    except (ValueError, OSError):
        return ""
    return "../" + _quote_path(rel.as_posix())


def _normalize_lookup_text(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _load_manifest(manifest_path: Path = MANIFEST_PATH) -> list[dict]:
    if not manifest_path.exists():
        return []
    with open(manifest_path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    if isinstance(raw, dict):
        items = raw.get("papers") or raw.get("items") or raw.get("archive") or []
    else:
        items = raw
    if not isinstance(items, list):
        return []
    if any(not isinstance(entry, dict) for entry in items):
        raise ValueError("Every manifest entry must be an object; stable IDs cannot be shifted.")
    return items


def _manifest_value(entry: dict, names: tuple) -> str:
    for name in names:
        for key, value in entry.items():
            if _normalize_lookup_text(str(key)) == _normalize_lookup_text(name):
                if value is None:
                    return ""
                if isinstance(value, str):
                    return value.strip()
                if isinstance(value, (int, float)):
                    return str(value)
    return ""


def _manifest_row(entry: dict, index: int, library: Path = LIBRARY, metadata: Optional[dict] = None) -> dict:
    rel_path = _manifest_value(entry, ("dest", "path", "file", "filePath", "pdfPath", "pdf"))
    rel_path = rel_path.replace("\\", "/")
    title = (metadata or {}).get("title") or _manifest_value(entry, ("title", "name"))
    category = _manifest_value(entry, ("category", "topic", "area", "folder", "section"))
    key = _manifest_value(entry, ("key", "zoteroKey", "parentKey", "zotero", "itemKey"))
    pdf_path = (Path(library) / rel_path) if rel_path else None
    if not title:
        if rel_path:
            title = Path(rel_path).stem
        else:
            title = f"Paper {index}"
    if not category and rel_path:
        parts = Path(rel_path).parts
        category = parts[0] if len(parts) > 1 else ""
    pdf_url = _relative_from_reader(pdf_path, library) if pdf_path is not None else ""
    return {
        "index": index,
        "title": title,
        "category": category,
        "key": key.upper() if key else "",
        "relPath": rel_path,
        "pdfPath": pdf_path,
        "pdfUrl": pdf_url,
    }


def _manifest_rows(library: Path = LIBRARY) -> list[dict]:
    library = Path(library)
    metadata_path = library / "Paper Metadata.json"
    metadata = {}
    if metadata_path.exists():
        snapshot = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata = {row["file_id"]: row for row in snapshot.get("records", [])}
    return [_manifest_row(entry, i, library, metadata.get(i))
            for i, entry in enumerate(_load_manifest(library / "Archive Manifest.json"))]


# ---------------------------------------------------------------------------
# Zotero read-only SQLite access
# ---------------------------------------------------------------------------


class ZoteroError(RuntimeError):
    pass


class ZoteroReadOnly:
    """A read-only handle to the Zotero SQLite database.

    The database is opened with ``mode=ro`` and a real read transaction so
    that WAL contents are included (never ``immutable=1``).
    """

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        if not self.db_path.exists():
            raise ZoteroError(f"Zotero database not found: {self.db_path}")
        self.conn: Optional[sqlite3.Connection] = None
        self.columns: dict[str, set[str]] = {}
        self._open()

    def _open(self) -> None:
        uri = self.db_path.resolve().as_uri() + "?mode=ro"
        last_err: Optional[Exception] = None
        for attempt in range(3):
            try:
                conn = sqlite3.connect(uri, uri=True, timeout=5.0, isolation_level=None)
                conn.row_factory = sqlite3.Row
                cur = conn.execute("BEGIN")
                conn.execute("SELECT name FROM sqlite_master LIMIT 1").fetchall()
                self.conn = conn
                cur.close()
                return
            except sqlite3.OperationalError as exc:
                last_err = exc
                msg = str(exc).lower()
                if "locked" in msg or "busy" in msg:
                    continue
                raise ZoteroError(f"Cannot open Zotero database read-only: {exc}") from exc
        raise ZoteroError(
            "Zotero database is locked or busy; close Zotero or retry shortly. "
            f"Last error: {last_err}"
        )

    def close(self) -> None:
        if self.conn is not None:
            try:
                self.conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            try:
                self.conn.close()
            except sqlite3.Error:
                pass
            self.conn = None

    def __enter__(self) -> "ZoteroReadOnly":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def table_columns(self, table: str) -> set[str]:
        if table in self.columns:
            return self.columns[table]
        assert self.conn is not None
        try:
            rows = self.conn.execute(f"PRAGMA table_info({table})").fetchall()
        except sqlite3.Error:
            rows = []
        cols = {row["name"] for row in rows}
        self.columns[table] = cols
        return cols

    def has_table(self, table: str) -> bool:
        assert self.conn is not None
        row = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        return row is not None

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        assert self.conn is not None
        try:
            return self.conn.execute(sql, tuple(params)).fetchall()
        except sqlite3.Error:
            return []

    # -- specific lookups -------------------------------------------------

    def item_by_key(self, key: str) -> Optional[sqlite3.Row]:
        if not key:
            return None
        rows = self.query(
            "SELECT itemID, key, libraryID, itemTypeID FROM items WHERE key=?", (key,)
        )
        return rows[0] if rows else None

    def item_type_name(self, item_type_id: Any) -> str:
        rows = self.query("SELECT typeName FROM itemTypes WHERE itemTypeID=?", (item_type_id,))
        return rows[0]["typeName"] if rows else ""

    def non_deleted_pdf_attachments(self, parent_item_id: int) -> list[sqlite3.Row]:
        deleted_table = "deletedItems"
        not_deleted = ""
        if self.has_table(deleted_table):
            not_deleted = (
                " AND a.itemID NOT IN (SELECT itemID FROM deletedItems)"
            )
        rows = self.query(
            "SELECT i.itemID, i.key, i.libraryID FROM itemAttachments a "
            "JOIN items i ON i.itemID = a.itemID "
            "WHERE a.parentItemID = ? "
            "AND (a.contentType = 'application/pdf' "
            "OR (a.contentType IS NULL AND a.path IS NOT NULL))" + not_deleted,
            (parent_item_id,),
        )
        return rows

    def attachment_path(self, attachment_item_id: int) -> tuple[Optional[Path], str]:
        rows = self.query("SELECT path FROM itemAttachments WHERE itemID=?", (attachment_item_id,))
        if not rows or not rows[0]["path"]:
            return None, ""
        raw = str(rows[0]["path"])
        storage_root = self._storage_root()
        if raw.startswith("storage:"):
            filename = raw[len("storage:"):]
            attach_key_rows = self.query("SELECT key FROM items WHERE itemID=?", (attachment_item_id,))
            if not attach_key_rows:
                return None, "storage"
            attach_key = attach_key_rows[0]["key"]
            candidate = storage_root / attach_key / filename
            return candidate, "storage"
        if raw.startswith("attachments:"):
            return None, "attachments"
        raw_path = Path(raw)
        if raw_path.is_absolute():
            return raw_path, "linked"
        return storage_root / raw, "storage"

    def _storage_root(self) -> Path:
        return DEFAULT_ZOTERO_STORAGE

    def annotations_for_item(self, attachment_item_id: int) -> list[dict]:
        cols = self.table_columns("itemAnnotations")
        deleted_filter = ""
        if self.has_table("deletedItems"):
            deleted_filter = (
                " AND a.itemID NOT IN (SELECT itemID FROM deletedItems)"
            )
        rows = self.query(
            "SELECT * FROM itemAnnotations a WHERE a.parentItemID = ?" + deleted_filter,
            (attachment_item_id,),
        )
        out: list[dict] = []
        for row in rows:
            out.append(self._build_annotation(row, cols))
        return out

    def _annotation_type_name(self, raw: Any) -> tuple[str, Any]:
        if raw is None:
            return "unknown", raw
        if isinstance(raw, str) and not raw.isdigit():
            return raw, raw
        try:
            n = int(raw)
        except (TypeError, ValueError):
            return "unknown", raw
        return ANNOTATION_TYPES.get(n, f"type-{n}"), n

    def _build_annotation(self, row: sqlite3.Row, cols: set[str]) -> dict:
        keys = row.keys()
        item_id = row["itemID"] if "itemID" in keys else None
        item_rows = self.query("SELECT key, version FROM items WHERE itemID=?", (item_id,)) if item_id is not None else []
        key = item_rows[0]["key"] if item_rows else (row["key"] if "key" in keys else None)
        version = item_rows[0]["version"] if item_rows and "version" in item_rows[0].keys() else None
        date_modified = None
        if "dateModified" in cols and "dateModified" in keys:
            date_modified = _epoch_ms_to_iso(row["dateModified"])
        type_name, type_raw = self._annotation_type_name(row["type"] if "type" in keys else None)
        position = None
        if "position" in cols and "position" in keys and row["position"]:
            try:
                position = json.loads(row["position"])
            except (json.JSONDecodeError, TypeError):
                position = row["position"]
        read_only = False
        if "isExternal" in cols and "isExternal" in keys:
            try:
                read_only = bool(int(row["isExternal"]))
            except (TypeError, ValueError):
                read_only = bool(row["isExternal"])
        ann = {
            "id": key,
            "key": key,
            "version": version,
            "type": type_name,
            "text": row["text"] if "text" in keys else "",
            "comment": row["comment"] if "comment" in keys else "",
            "color": row["color"] if "color" in keys else "",
            "pageLabel": row["pageLabel"] if "pageLabel" in keys else "",
            "sortIndex": row["sortIndex"] if "sortIndex" in keys else "",
            "position": position,
            "tags": self._tags_for_item(item_id) if item_id is not None else [],
            "dateModified": date_modified,
            "readOnly": read_only,
        }
        if type_name.startswith("type-") or type_name == "unknown":
            # Preserve unknown annotation types losslessly.
            raw = {}
            for k in keys:
                raw[k] = row[k]
            ann["rawData"] = raw
            ann["rawType"] = type_raw
        return ann

    def _tags_for_item(self, item_id: int) -> list[str]:
        if not self.has_table("itemTags") or not self.has_table("tags"):
            return []
        rows = self.query(
            "SELECT t.name FROM tags t JOIN itemTags it ON it.tagID = t.tagID WHERE it.itemID=?",
            (item_id,),
        )
        return [r["name"] for r in rows if r["name"]]

    def notes_for_item(self, item_id: int) -> list[dict]:
        if not self.has_table("itemNotes"):
            return []
        cols = self.table_columns("itemNotes")
        deleted_filter = ""
        if self.has_table("deletedItems"):
            deleted_filter = " AND n.itemID NOT IN (SELECT itemID FROM deletedItems)"
        rows = self.query("SELECT * FROM itemNotes n WHERE n.parentItemID = ?" + deleted_filter, (item_id,))
        out = []
        for row in rows:
            if row["itemID"] in (item_id,):
                continue
            item_rows = self.query("SELECT key, version FROM items WHERE itemID=?", (row["itemID"],))
            key = item_rows[0]["key"] if item_rows else None
            version = item_rows[0]["version"] if item_rows else None
            date_modified = None
            if "dateModified" in cols and "dateModified" in row.keys():
                date_modified = _epoch_ms_to_iso(row["dateModified"])
            out.append(
                {
                    "id": key,
                    "key": key,
                    "version": version,
                    "html": row["note"] if "note" in row.keys() else "",
                    "dateModified": date_modified,
                }
            )
        return out

    def child_notes_for_parent(self, parent_item_id: int) -> list[dict]:
        return self.notes_for_item(parent_item_id)

    def title_for_item(self, item_id: int) -> str:
        field_rows = self.query(
            "SELECT f.fieldName, d.value FROM itemData d "
            "JOIN fields f ON f.fieldID = d.fieldID "
            "WHERE d.itemID=? AND f.fieldName='title'",
            (item_id,),
        )
        for row in field_rows:
            if row["value"]:
                return row["value"]
        title_rows = self.query("SELECT value FROM itemDataValues WHERE value=? LIMIT 0")
        _ = title_rows
        return ""

    def child_attachments_for_parent(self, parent_item_id: int) -> list[sqlite3.Row]:
        return self.non_deleted_pdf_attachments(parent_item_id)


# ---------------------------------------------------------------------------
# Hash cache
# ---------------------------------------------------------------------------


class HashCache:
    def __init__(self, path: Path = HASH_CACHE_PATH):
        self.path = path
        self.entries: dict[str, dict] = {}
        self.dirty = False
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                self.entries = data.get("entries", {})
        except (OSError, json.JSONDecodeError):
            self.entries = {}

    def sha256(self, path: Path) -> Optional[str]:
        try:
            stat = path.stat()
        except OSError:
            return None
        key = str(path.resolve())
        cached = self.entries.get(key)
        if cached and cached.get("size") == stat.st_size and cached.get("mtime_ns") == stat.st_mtime_ns:
            return cached.get("sha256")
        digest = _sha256_file(path)
        if digest is None:
            return None
        self.entries[key] = {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "sha256": digest}
        self.dirty = True
        return digest

    def save(self) -> None:
        if not self.dirty:
            return
        try:
            _atomic_write_json(self.path, {"entries": self.entries})
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Attachment resolution
# ---------------------------------------------------------------------------


def _is_under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False


def _resolve_attachments(
    z: ZoteroReadOnly,
    row: dict,
    cache: HashCache,
    report: dict,
) -> dict:
    """Resolve the manifest parent key to its matching PDF attachment."""
    empty = {"attachmentKey": None, "basis": "none", "annotations": [], "notes": []}
    if not row["key"]:
        return {**empty, "status": "unlinked"}
    pdf_path = row.get("pdfPath")
    if pdf_path is None or not pdf_path.exists():
        return {**empty, "status": "unmatched"}
    parent = z.item_by_key(row["key"])
    if parent is None:
        return {**empty, "status": "unmatched"}
    parent_id = parent["itemID"]
    notes = z.child_notes_for_parent(parent_id)
    content_hash = cache.sha256(pdf_path)
    report["hashedFiles"] = report.get("hashedFiles", 0) + 1
    if content_hash is None:
        return {**empty, "status": "unmatched", "notes": notes}

    matches = []
    candidates = z.child_attachments_for_parent(parent_id)
    for att in candidates:
        candidate_path, kind = z.attachment_path(att["itemID"])
        if candidate_path is None:
            continue
        if not candidate_path.exists() or not candidate_path.is_file():
            continue
        if not candidate_path.name.lower().endswith(".pdf"):
            continue
        if kind == "storage" and not _is_under(candidate_path, z._storage_root()):
            continue
        if kind == "linked" and not candidate_path.is_absolute():
            continue
        digest = cache.sha256(candidate_path)
        if digest == content_hash:
            matches.append((att, candidate_path, kind))

    distinct = {att["key"] for att, _p, _k in matches}
    if len(distinct) == 1:
        att, _p, _k = matches[0]
        annotations = z.annotations_for_item(att["itemID"])
        return {
            "status": "matched",
            "basis": "sha256",
            "attachmentKey": att["key"],
            "annotations": annotations,
            "notes": notes,
        }
    if not distinct:
        return {**empty, "status": "unmatched", "notes": notes}
    return {**empty, "status": "ambiguous", "notes": notes}


# ---------------------------------------------------------------------------
# Note image extraction
# ---------------------------------------------------------------------------


_ATTACHMENT_KEY_RE = re.compile(r"data-attachment-key\s*=\s*['\"]([A-Za-z0-9]+)['\"]", re.IGNORECASE)
_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)


def _copy_note_images(
    z: ZoteroReadOnly,
    note_html: str,
    public_assets: Path,
    source_assets: Path,
    cache: HashCache,
    report: dict,
    dry_run: bool,
) -> tuple[str, str]:
    """Return ``(display_html, unresolved_note)`` based on note_html."""
    if not note_html:
        return note_html or "", ""
    keys = sorted(set(_ATTACHMENT_KEY_RE.findall(note_html)))
    if not keys:
        return note_html, ""
    replace_map: dict[str, str] = {}
    unresolved: list[str] = []
    for key in keys:
        rows = z.query("SELECT itemID FROM items WHERE key=?", (key,))
        if not rows:
            unresolved.append(key)
            continue
        item_id = rows[0]["itemID"]
        path, kind = z.attachment_path(item_id)
        if path is None or not path.exists() or not path.is_file():
            unresolved.append(key)
            continue
        try:
            rel = path.resolve().relative_to(z._storage_root().resolve())
        except (ValueError, OSError):
            rel = None
        if rel is None:
            unresolved.append(key)
            continue
        subpath = Path(*rel.parts[1:])
        ext = path.suffix or ".bin"
        dest_rel = Path("note-images") / key / (subpath.name if subpath.name else f"image{ext}")
        dest_src = source_assets / dest_rel
        dest_pub = public_assets / dest_rel
        if not dry_run:
            try:
                _atomic_copy_file(path, dest_src)
                _atomic_copy_file(path, dest_pub)
            except OSError:
                unresolved.append(key)
                continue
        replace_map[key] = "assets/" + dest_rel.as_posix()

    def _rewrite(match: re.Match) -> str:
        tag = match.group(0)
        key_m = _ATTACHMENT_KEY_RE.search(tag)
        if not key_m:
            return tag
        key = key_m.group(1)
        if key not in replace_map:
            return '<span class="image-unavailable" role="note">This image was not available in the Zotero attachment storage.</span>'
        if not re.search(r"\bsrc\s*=", tag, re.IGNORECASE):
            return tag[:-1] + f' src="{replace_map[key]}">'
        return re.sub(
            r"\bsrc\s*=\s*(['\"]).*?\1",
            f'src="{replace_map[key]}"',
            tag,
            count=1,
            flags=re.IGNORECASE,
        )

    display_html = _IMG_TAG_RE.sub(_rewrite, note_html)
    if unresolved:
        report["missingImages"] = report.get("missingImages", 0) + len(unresolved)
        report.setdefault("unresolvedImages", []).extend(unresolved)
    return display_html, ""


# ---------------------------------------------------------------------------
# Export orchestration
# ---------------------------------------------------------------------------


def _load_existing_papers() -> dict:
    if not SOURCE_PAPERS.exists():
        return {}
    try:
        with open(SOURCE_PAPERS, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _existing_exported_at() -> Optional[str]:
    data = _load_existing_papers()
    val = data.get("exportedAt")
    return val if isinstance(val, str) else None


def _existing_per_file(file_id: int) -> dict:
    path = SOURCE_DATA / f"{file_id}.json"
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _per_file_content_equals(old: dict, new: dict) -> bool:
    a = dict(old)
    b = dict(new)
    old_ts = a.pop("exportedAt", None)
    b.pop("exportedAt", None)
    if a != b:
        return False
    return isinstance(old_ts, str) and bool(old_ts)


def _pick_timestamp(content_changed: bool, prior: Optional[str]) -> str:
    if not content_changed and prior:
        return prior
    return _now_iso()


def _build_paper_entries(rows: list[dict], resolutions: Optional[dict[int, dict]]) -> list[dict]:
    out = []
    for row in rows:
        idx = row["index"]
        res = resolutions.get(idx) if resolutions else None
        zinfo = None
        anns = []
        notes = []
        mapping_status = "unlinked"
        basis = "none"
        if res and row["key"]:
            zinfo = {
                "libraryType": "user",
                "libraryId": 1,
                "parentKey": row["key"],
            }
            if res.get("attachmentKey"):
                zinfo["attachmentKey"] = res["attachmentKey"]
            anns = res.get("annotations") or []
            notes = res.get("notes") or []
            mapping_status = res.get("status", "unmatched")
            basis = res.get("basis", "none")
        elif not row["key"]:
            mapping_status = "unlinked"
            basis = "none"
        out.append(
            {
                "row": row,
                "zotero": zinfo,
                "annotations": anns,
                "notes": notes,
                "mapping": {"status": mapping_status, "basis": basis},
            }
        )
    return out


def _finalize_notes_for_row(
    z: Optional[ZoteroReadOnly],
    notes: list[dict],
    public_assets: Path,
    source_assets: Path,
    cache: HashCache,
    report: dict,
    dry_run: bool,
) -> list[dict]:
    out = []
    for note in notes:
        new_note = dict(note)
        raw_html = note.get("html") or ""
        if z is not None and raw_html:
            display_html, _ = _copy_note_images(z, raw_html, public_assets, source_assets, cache, report, dry_run)
            new_note["displayHtml"] = display_html
        else:
            new_note["displayHtml"] = raw_html
        out.append(new_note)
    return out


def _write_papers_json(papers: list[dict], exported_at: str) -> bool:
    registry = {
        "schemaVersion": SCHEMA_VERSION,
        "exportedAt": exported_at,
        "papers": papers,
    }
    old = _load_existing_papers()
    old_cmp = {k: v for k, v in old.items() if k != "exportedAt"}
    new_cmp = {k: v for k, v in registry.items() if k != "exportedAt"}
    if old_cmp == new_cmp and old.get("exportedAt"):
        return False
    _atomic_write_json(SOURCE_PAPERS, registry)
    _atomic_write_json(PUBLIC_PAPERS, registry)
    return True


def _copy_static_assets() -> list[Path]:
    """Copy only the intended static web files to source and public readers."""
    written: list[Path] = []
    targets = ((HERE, SOURCE_READER), (HERE, PUBLIC_READER))
    for src_dir, dst_root in targets:
        if dst_root is None:
            dst_root = PUBLIC_READER
        for name in STATIC_WEB_FILES:
            src = src_dir / name
            if not src.exists():
                continue
            dst = dst_root / name
            _atomic_copy_file(src, dst)
            written.append(dst)
        vendor_src = src_dir / VENDOR_DIRNAME
        if vendor_src.is_dir():
            for item in vendor_src.rglob("*"):
                if item.is_file() and item.suffix.lower() != ".py":
                    rel = item.relative_to(vendor_src)
                    dst = dst_root / VENDOR_DIRNAME / rel
                    _atomic_copy_file(item, dst)
                    written.append(dst)
        assets_src = src_dir / "assets"
        if assets_src.is_dir():
            for item in assets_src.rglob("*"):
                if item.is_file() and item.suffix.lower() != ".py":
                    rel = item.relative_to(assets_src)
                    dst = dst_root / "assets" / rel
                    _atomic_copy_file(item, dst)
                    written.append(dst)
    return written


def _run_import(zotero_db: Path, dry_run: bool) -> dict:
    report: dict = {
        "mode": "initial-import",
        "dryRun": bool(dry_run),
        "basis": "sqlite-read-only",
        "startedAt": _now_iso(),
        "importedNotes": 0,
        "importedAnnotations": 0,
        "exactMatched": 0,
        "unmatched": 0,
        "ambiguous": 0,
        "unlinked": 0,
        "missingImages": 0,
        "unresolvedImages": [],
        "mappings": [],
    }
    rows = _manifest_rows()
    if not rows:
        report["error"] = f"No manifest entries at {MANIFEST_PATH}"
        _persist_report(report, dry_run)
        return report

    cache = HashCache()
    resolutions: dict[int, dict] = {}
    try:
        global DEFAULT_ZOTERO_STORAGE
        db_dir = Path(zotero_db).resolve().parent
        DEFAULT_ZOTERO_STORAGE = db_dir / "storage"
        with ZoteroReadOnly(Path(zotero_db)) as z:
            for row in rows:
                res = _resolve_attachments(z, row, cache, report)
                resolutions[row["index"]] = res
                report["mappings"].append(
                    {
                        "fileId": row["index"],
                        "parentKey": row["key"],
                        "status": res.get("status"),
                        "basis": res.get("basis"),
                        "attachmentKey": res.get("attachmentKey"),
                    }
                )
                status = res.get("status")
                if status == "matched":
                    report["exactMatched"] += 1
                    report["importedAnnotations"] += len(res.get("annotations") or [])
                elif status == "ambiguous":
                    report["ambiguous"] += 1
                elif status == "unlinked":
                    report["unlinked"] += 1
                else:
                    report["unmatched"] += 1

            built = _build_paper_entries(rows, resolutions)
            registry_papers = []
            per_files: dict[int, dict] = {}
            for entry in built:
                row = entry["row"]
                notes = _finalize_notes_for_row(
                    z,
                    entry["notes"],
                    PUBLIC_ASSETS,
                    SOURCE_ASSETS,
                    cache,
                    report,
                    dry_run,
                )
                report["importedNotes"] += len(notes)
                pdf_info = {"url": row["pdfUrl"], "sha256": None}
                if row.get("pdfPath") is not None and row["pdfPath"].exists():
                    pdf_info["sha256"] = cache.sha256(row["pdfPath"])
                registry_papers.append(
                    {
                        "fileId": row["index"],
                        "title": row["title"],
                        "category": row["category"],
                        "pdfUrl": row["pdfUrl"],
                        "dataUrl": f"data/{row['index']}.json",
                        "zotero": entry["zotero"],
                    }
                )
                per_files[row["index"]] = {
                    "schemaVersion": SCHEMA_VERSION,
                    "fileId": row["index"],
                    "pdf": pdf_info,
                    "zotero": entry["zotero"],
                    "mapping": entry["mapping"],
                    "annotations": entry["annotations"],
                    "notes": notes,
                }

            if not dry_run:
                new_exported_at = _now_iso()
                any_registry_change = _write_papers_json(registry_papers, new_exported_at)
                for file_id, content in per_files.items():
                    old = _existing_per_file(file_id)
                    if _per_file_content_equals(old, content):
                        content["exportedAt"] = old.get("exportedAt")
                    else:
                        content["exportedAt"] = new_exported_at
                    content["fileId"] = file_id
                    _atomic_write_json(SOURCE_DATA / f"{file_id}.json", content)
                    _atomic_write_json(PUBLIC_DATA / f"{file_id}.json", content)
                if any_registry_change:
                    report["registryUpdated"] = True
                _copy_static_assets()
            else:
                report["wouldWrite"] = {
                    "papersJson": str(SOURCE_PAPERS),
                    "perFileCount": len(per_files),
                }
    except ZoteroError as exc:
        report["error"] = str(exc)
    finally:
        cache.save()
    report["finishedAt"] = _now_iso()
    _persist_report(report, dry_run)
    return report


def _persist_report(report: dict, dry_run: bool) -> None:
    if dry_run:
        return
    try:
        _atomic_write_json(REPORT_PATH, report)
    except OSError:
        pass


def _run_export_assets() -> dict:
    report = {"mode": "export-assets", "startedAt": _now_iso(), "written": []}
    written = _copy_static_assets()
    report["written"] = [str(p) for p in written]
    _sync_public_data()
    report["finishedAt"] = _now_iso()
    _persist_report(report, False)
    return report


def _sync_public_data() -> None:
    if SOURCE_DATA.is_dir():
        for item in SOURCE_DATA.glob("*.json"):
            if item.name.endswith(".py"):
                continue
            _atomic_copy_file(item, PUBLIC_DATA / item.name)


def _build_registry_papers_only(rows: list[dict]) -> list[dict]:
    papers = []
    for row in rows:
        papers.append(
            {
                "fileId": row["index"],
                "title": row["title"],
                "category": row["category"],
                "pdfUrl": row["pdfUrl"],
                "dataUrl": f"data/{row['index']}.json",
                "zotero": (
                    {"libraryType": "user", "libraryId": 1, "parentKey": row["key"]}
                    if row["key"]
                    else None
                ),
            }
        )
    return papers


def _offline_refresh(create_missing_only: bool = True) -> dict:
    rows = _manifest_rows()
    report = {"mode": "offline-refresh", "startedAt": _now_iso(), "created": [], "preserved": []}
    papers = _build_registry_papers_only(rows)
    old = _load_existing_papers()
    old_cmp = {k: v for k, v in old.items() if k != "exportedAt"}
    new_cmp = {"schemaVersion": SCHEMA_VERSION, "papers": papers}
    if old_cmp == new_cmp and old.get("exportedAt"):
        exported_at = old["exportedAt"]
    else:
        exported_at = _now_iso()
    _write_papers_json(papers, exported_at)
    for row in rows:
        fid = row["index"]
        src_path = SOURCE_DATA / f"{fid}.json"
        pub_path = PUBLIC_DATA / f"{fid}.json"
        if src_path.exists() and create_missing_only:
            report["preserved"].append(fid)
            if not pub_path.exists():
                _atomic_copy_file(src_path, pub_path)
            continue
        record = {
            "schemaVersion": SCHEMA_VERSION,
            "fileId": fid,
            "exportedAt": exported_at,
            "pdf": {"url": row["pdfUrl"], "sha256": None},
            "zotero": (
                {"libraryType": "user", "libraryId": 1, "parentKey": row["key"]}
                if row["key"]
                else None
            ),
            "mapping": {"status": "unlinked" if not row["key"] else "unmatched", "basis": "none"},
            "annotations": [],
            "notes": [],
        }
        _atomic_write_json(src_path, record)
        _atomic_write_json(pub_path, record)
        report["created"].append(fid)
    _copy_static_assets()
    report["finishedAt"] = _now_iso()
    _persist_report(report, False)
    return report


def _print_summary(report: dict) -> None:
    if "error" in report:
        print(f"ERROR ({report.get('mode')}): {report['error']}")
        return
    if report.get("mode") == "initial-import":
        print(
            "Imported: notes={importedNotes} annotations={importedAnnotations} "
            "exactMatched={exactMatched} unmatched={unmatched} ambiguous={ambiguous} "
            "missingImages={missingImages}".format(**{k: report.get(k, 0) for k in (
                "importedNotes", "importedAnnotations", "exactMatched", "unmatched", "ambiguous", "missingImages"
            )})
        )
        if report.get("dryRun"):
            ww = report.get("wouldWrite")
            if ww:
                print(f"DRY-RUN would write papers.json and {ww.get('perFileCount')} per-file JSONs")
        return
    if report.get("mode") == "offline-refresh":
        print(
            f"Offline refresh: created={len(report.get('created', []))} "
            f"preserved={len(report.get('preserved', []))}"
        )
        return
    if report.get("mode") == "export-assets":
        print(f"Exported static assets: {len(report.get('written', []))} files")
        return


def _run_report() -> dict:
    report = {"mode": "report", "startedAt": _now_iso()}
    papers = _load_existing_papers()
    entries = papers.get("papers") or []
    report["paperCount"] = len(entries)
    matched = unmatched = ambiguous = unlinked = notes = anns = 0
    for entry in entries:
        fid = entry.get("fileId")
        data = _existing_per_file(fid) if isinstance(fid, int) else {}
        status = (data.get("mapping") or {}).get("status")
        if status == "matched":
            matched += 1
        elif status == "ambiguous":
            ambiguous += 1
        elif status == "unmatched":
            unmatched += 1
        else:
            unlinked += 1
        notes += len(data.get("notes") or [])
        anns += len(data.get("annotations") or [])
    report.update(
        {
            "exactMatched": matched,
            "unmatched": unmatched,
            "ambiguous": ambiguous,
            "unlinked": unlinked,
            "importedNotes": notes,
            "importedAnnotations": anns,
            "exportedAt": papers.get("exportedAt"),
        }
    )
    report["finishedAt"] = _now_iso()
    _persist_report(report, False)
    return report


# ---------------------------------------------------------------------------
# Quick-add integration contract
# ---------------------------------------------------------------------------


def _paper_file_id_for(file_id: int) -> int:
    return int(file_id)


def _build_record(file_id: int, row: Optional[dict], exported_at: str) -> dict:
    pdf_url = row["pdfUrl"] if row else ""
    parent_key = row["key"] if row else ""
    return {
        "schemaVersion": SCHEMA_VERSION,
        "fileId": file_id,
        "exportedAt": exported_at,
        "pdf": {"url": pdf_url, "sha256": None},
        "zotero": (
            {"libraryType": "user", "libraryId": 1, "parentKey": parent_key}
            if parent_key
            else None
        ),
        "mapping": {"status": "unlinked", "basis": "none"},
        "annotations": [],
        "notes": [],
    }


def ensure_reader_record(
    file_id: int,
    library: Path = LIBRARY,
    site: Path = SITE,
) -> list[Path]:
    """Deterministically materialize a reader record for a quick-added paper.

    Pure offline: no Zotero, no hashing, no network. Regenerates the
    registry from the manifest and creates the per-file JSON if absent.
    Never overwrites existing per-file data snapshots.
    """
    library = Path(library)
    site = Path(site)
    src_reader = library / "reader"
    pub_reader = site / "papers" / "reader"
    src_data = src_reader / "data"
    pub_data = pub_reader / "data"

    manifest_path = library / "Archive Manifest.json"
    if not manifest_path.is_file():
        raise ValueError("The paper manifest is missing.")
    rows = _manifest_rows(library)
    fid = _paper_file_id_for(file_id)
    row = next((r for r in rows if r["index"] == fid), None)
    if row is None:
        raise ValueError("The reader file ID is outside the paper manifest.")
    for existing_path in (src_data / f"{fid}.json", pub_data / f"{fid}.json"):
        if existing_path.exists():
            existing = json.loads(existing_path.read_text(encoding="utf-8"))
            if existing.get("fileId") != fid or (existing.get("pdf") or {}).get("url") != row["pdfUrl"]:
                raise ValueError("An existing reader snapshot belongs to a different paper; no reader files were changed.")
    registry_papers = _build_registry_papers_only(rows)

    src_registry = src_reader / "papers.json"
    pub_registry = pub_reader / "papers.json"
    old = {}
    if src_registry.exists():
        try:
            with open(src_registry, "r", encoding="utf-8") as fh:
                old = json.load(fh)
        except (OSError, json.JSONDecodeError):
            old = {}
    prior_papers = {p.get("fileId"): p for p in old.get("papers", [])} if isinstance(old, dict) else {}
    for paper in registry_papers:
        prior_zotero = prior_papers.get(paper["fileId"], {}).get("zotero")
        if prior_zotero and paper["zotero"] and prior_zotero.get("parentKey") == paper["zotero"].get("parentKey"):
            paper["zotero"] = prior_zotero
    old_cmp = {k: v for k, v in old.items() if k != "exportedAt"} if isinstance(old, dict) else {}
    new_cmp = {"schemaVersion": SCHEMA_VERSION, "papers": registry_papers}
    if old_cmp == new_cmp and isinstance(old, dict) and old.get("exportedAt"):
        exported_at = old["exportedAt"]
    else:
        exported_at = _now_iso()

    written: list[Path] = []

    registry_payload = {
        "schemaVersion": SCHEMA_VERSION,
        "exportedAt": exported_at,
        "papers": registry_papers,
    }
    src_registry.parent.mkdir(parents=True, exist_ok=True)
    pub_registry.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(src_registry, registry_payload)
    _atomic_write_json(pub_registry, registry_payload)
    written.extend([src_registry, pub_registry])

    src_target = src_data / f"{fid}.json"
    pub_target = pub_data / f"{fid}.json"
    if not src_target.exists():
        record = _build_record(fid, row, exported_at)
        _atomic_write_json(src_target, record)
    if not pub_target.exists():
        if src_target.exists():
            _atomic_copy_file(src_target, pub_target)
        else:
            record = _build_record(fid, row, exported_at)
            _atomic_write_json(pub_target, record)
    written.extend([src_target, pub_target])
    return written


def reader_record_paths(
    file_id: int,
    library: Path = LIBRARY,
    site: Path = SITE,
) -> list[Path]:
    """Return just the four Paths changed by ``ensure_reader_record``."""
    library = Path(library)
    site = Path(site)
    src_reader = library / "reader"
    pub_reader = site / "papers" / "reader"
    fid = _paper_file_id_for(file_id)
    return [
        src_reader / "papers.json",
        src_reader / "data" / f"{fid}.json",
        pub_reader / "papers.json",
        pub_reader / "data" / f"{fid}.json",
    ]


def _try_api_refresh() -> Optional[dict]:
    """Optional best-effort check of the Zotero 10 local API.

    Returns a small status dict or ``None``. Never blocks export.
    """
    try:
        req = urllib.request.Request("http://127.0.0.1:23119/api/users/0/items?limit=1", method="GET")
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            server_id = resp.headers.get("Zotero-Server-ID")
            _ = resp.read(64)
        return {"reachable": True, "serverId": server_id}
    except (urllib.error.URLError, OSError, ValueError):
        return {"reachable": False, "serverId": None}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Paper Library reader exporter")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--initial-import", action="store_true", help="Read-only import from Zotero SQLite")
    group.add_argument("--export-assets", action="store_true", help="Refresh static assets and public mirrors")
    group.add_argument("--report", action="store_true", help="Print counts from the existing export")
    parser.add_argument("--zotero-db", default=str(DEFAULT_ZOTERO_DB), help="Path to zotero.sqlite")
    parser.add_argument("--dry-run", action="store_true", help="Report mappings without writing")
    args = parser.parse_args(argv)

    if args.initial_import:
        db_path = Path(args.zotero_db)
        report = _run_import(db_path, dry_run=args.dry_run)
        _print_summary(report)
        return 0 if "error" not in report else 2

    if args.export_assets:
        report = _run_export_assets()
        _print_summary(report)
        return 0

    if args.report:
        report = _run_report()
        print(
            "Report: papers={} matched={} unmatched={} ambiguous={} unlinked={} "
            "notes={} annotations={}".format(
                report.get("paperCount", 0),
                report.get("exactMatched", 0),
                report.get("unmatched", 0),
                report.get("ambiguous", 0),
                report.get("unlinked", 0),
                report.get("importedNotes", 0),
                report.get("importedAnnotations", 0),
            )
        )
        return 0

    # Default offline mode: refresh assets + registry, create missing data only.
    report = _offline_refresh(create_missing_only=True)
    _print_summary(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
