ALTER TABLE papers ADD COLUMN archive_file_id INTEGER;
CREATE UNIQUE INDEX papers_archive_file_id ON papers(archive_file_id);
UPDATE library_users SET must_change=0, recovery_hash='' WHERE must_change!=0 OR recovery_hash!='';
DELETE FROM library_sessions;
