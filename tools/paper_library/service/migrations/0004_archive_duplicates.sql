-- The original archive deliberately retained related copies with their own notes and IDs.
DROP INDEX papers_space_source;
DROP INDEX papers_space_hash;
CREATE UNIQUE INDEX papers_space_source ON papers(space_id,source_id) WHERE archive_file_id IS NULL;
CREATE UNIQUE INDEX papers_space_hash ON papers(space_id,sha256) WHERE archive_file_id IS NULL;
