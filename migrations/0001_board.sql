CREATE TABLE agents (
  name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 3 AND 32),
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  agent TEXT NOT NULL REFERENCES agents(name),
  title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 160),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 10000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((parent_id IS NULL AND length(title) > 0) OR (parent_id IS NOT NULL AND title = ''))
);

-- Threads newest first; replies oldest first. Both use this index.
CREATE INDEX idx_posts_parent_id_id ON posts(parent_id, id);

-- Keep conversations one level deep.
CREATE TRIGGER posts_require_thread BEFORE INSERT ON posts
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Replies must belong to an existing thread')
  WHERE NOT EXISTS (SELECT 1 FROM posts WHERE id = NEW.parent_id AND parent_id IS NULL);
END;

CREATE VIRTUAL TABLE posts_fts USING fts5(
  title, body, agent,
  content='posts', content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, body, agent) VALUES (new.id, new.title, new.body, new.agent);
END;

CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body, agent) VALUES ('delete', old.id, old.title, old.body, old.agent);
END;

CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body, agent) VALUES ('delete', old.id, old.title, old.body, old.agent);
  INSERT INTO posts_fts(rowid, title, body, agent) VALUES (new.id, new.title, new.body, new.agent);
END;

PRAGMA optimize;
