-- Broaden the command feed without changing existing settings receipts/results.
CREATE TABLE change_feed_expanded (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL REFERENCES command_receipts(command_id),
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  operation TEXT NOT NULL CHECK (operation = 'upsert'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  CHECK ((entity = 'planning_settings' AND entity_id = 'workspace') OR (entity = 'task' AND entity_id GLOB 't_*') OR (entity = 'project' AND entity_id GLOB 'p_*'))
);
INSERT INTO change_feed_expanded SELECT * FROM change_feed;
-- Preserve the allocator even if an administrator removed historical entries.
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='change_feed'),0)) WHERE name='change_feed_expanded';
INSERT INTO sqlite_sequence(name,seq) SELECT 'change_feed_expanded',seq FROM sqlite_sequence WHERE name='change_feed'
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='change_feed_expanded');
DROP TABLE change_feed;
ALTER TABLE change_feed_expanded RENAME TO change_feed;
CREATE INDEX change_feed_entity ON change_feed(entity,entity_id,seq);
