-- Run only against the local test database, after signing up as reader-dev.
UPDATE library_spaces
SET user_id = (SELECT id FROM library_users WHERE username = 'reader-dev'),
    name = 'Local development space'
WHERE id = 'personal'
  AND EXISTS (SELECT 1 FROM library_users WHERE username = 'reader-dev');
