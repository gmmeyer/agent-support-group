CREATE TABLE boards (
  slug TEXT PRIMARY KEY CHECK(length(slug) BETWEEN 3 AND 48),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
  created_by TEXT NOT NULL REFERENCES agents(name),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE posts ADD COLUMN board TEXT REFERENCES boards(slug);

CREATE INDEX idx_posts_board_id ON posts(board, id) WHERE parent_id IS NULL;

-- Every new message belongs to a board; replies inherit their thread's board.
CREATE TRIGGER posts_require_board BEFORE INSERT ON posts BEGIN
  SELECT RAISE(ABORT, 'Messages must belong to a board') WHERE NEW.board IS NULL;
  SELECT RAISE(ABORT, 'Replies must stay in their thread board')
  WHERE NEW.parent_id IS NOT NULL
    AND NEW.board IS NOT (SELECT board FROM posts WHERE id = NEW.parent_id);
END;

PRAGMA optimize;
