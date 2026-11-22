CREATE TABLE library_users (
 id TEXT PRIMARY KEY,
 username TEXT NOT NULL COLLATE NOCASE UNIQUE,
 password_hash TEXT NOT NULL,
 salt TEXT NOT NULL,
 recovery_hash TEXT NOT NULL,
 must_change INTEGER NOT NULL DEFAULT 0,
 admin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE library_sessions (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES library_users(id) ON DELETE CASCADE,
 expires INTEGER NOT NULL
);
CREATE INDEX library_sessions_user ON library_sessions(user_id);
CREATE INDEX library_sessions_expiry ON library_sessions(expires);
CREATE TABLE account_limits (
 scope TEXT PRIMARY KEY,
 window INTEGER NOT NULL,
 count INTEGER NOT NULL
);
CREATE TABLE library_spaces (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('legacy','r2')),
 config TEXT,
 UNIQUE(user_id, name COLLATE NOCASE)
);
INSERT INTO library_spaces(id,user_id,name,kind) VALUES
 ('personal','library-owner','Yak9Ce3teeh''s cloud space','legacy');
ALTER TABLE papers ADD COLUMN space_id TEXT REFERENCES library_spaces(id);
UPDATE papers SET space_id='personal';
ALTER TABLE papers ADD COLUMN object_key TEXT;
ALTER TABLE papers ADD COLUMN byte_size INTEGER;
CREATE TRIGGER papers_require_space_insert BEFORE INSERT ON papers WHEN NEW.space_id IS NULL
 BEGIN SELECT RAISE(ABORT,'Paper space required'); END;
CREATE TRIGGER papers_require_space_update BEFORE UPDATE OF space_id ON papers WHEN NEW.space_id IS NULL
 BEGIN SELECT RAISE(ABORT,'Paper space required'); END;
DROP INDEX papers_source_id_unique;
DROP INDEX papers_sha256_unique;
CREATE UNIQUE INDEX papers_space_source ON papers(space_id,source_id);
CREATE UNIQUE INDEX papers_space_hash ON papers(space_id,sha256);
