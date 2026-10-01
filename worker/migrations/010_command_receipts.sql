-- Initial reliable command family: planning settings only. Legacy task writers
-- remain unchanged until their revisions/feed and client reconciliation land.
CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE command_audit (
  command_id TEXT PRIMARY KEY NOT NULL REFERENCES command_receipts(command_id),
  actor TEXT NOT NULL CHECK (actor IN ('user','llm','import','system')),
  reason TEXT,
  changes_json TEXT NOT NULL CHECK (json_valid(changes_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE change_feed (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL REFERENCES command_receipts(command_id),
  entity TEXT NOT NULL CHECK (entity = 'planning_settings'),
  entity_id TEXT NOT NULL CHECK (entity_id = 'workspace'),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  operation TEXT NOT NULL CHECK (operation = 'upsert'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX change_feed_entity ON change_feed(entity, entity_id, seq);
