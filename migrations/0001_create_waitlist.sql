-- Waitlist signups from huddleai.org.
--
-- The email is the primary key, stored trimmed and lower-cased by the Worker,
-- so a second signup from the same address is a no-op rather than a duplicate
-- row. `source` records the hostname the form was posted from, which is how a
-- signup from the apex is told apart from one made against a preview build.
CREATE TABLE IF NOT EXISTS waitlist (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS waitlist_created_at ON waitlist (created_at);
