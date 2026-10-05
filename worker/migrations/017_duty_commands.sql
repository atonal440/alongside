-- Allow duty commands in the legacy command feed while preserving history.
CREATE TABLE change_feed_duties (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL REFERENCES command_receipts(command_id),
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  CHECK ((entity = 'planning_settings' AND entity_id = 'workspace') OR (entity = 'task' AND entity_id GLOB 't_*') OR (entity = 'project' AND entity_id GLOB 'p_*') OR (entity = 'duty' AND entity_id GLOB 'd_*') OR (entity = 'link' AND CASE WHEN json_valid(entity_id) THEN json_type(entity_id) = 'array' AND json_array_length(entity_id) = 3 AND json_type(entity_id,'$[0]') = 'text' AND json_extract(entity_id,'$[0]') GLOB 't_*' AND json_type(entity_id,'$[1]') = 'text' AND json_extract(entity_id,'$[1]') GLOB 't_*' AND json_type(entity_id,'$[2]') = 'text' AND json_extract(entity_id,'$[2]') IN ('blocks','related') ELSE 0 END))
);
INSERT INTO change_feed_duties SELECT * FROM change_feed;
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='change_feed'),0)) WHERE name='change_feed_duties';
INSERT INTO sqlite_sequence(name,seq) SELECT 'change_feed_duties',seq FROM sqlite_sequence WHERE name='change_feed'
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='change_feed_duties');
DROP TABLE change_feed;
ALTER TABLE change_feed_duties RENAME TO change_feed;
CREATE INDEX change_feed_entity ON change_feed(entity,entity_id,seq);
