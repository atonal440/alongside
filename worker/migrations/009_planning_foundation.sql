-- Additive foundation only. Do not reinterpret legacy task due values here.
-- No settings are inferred from the deployer's host timezone.
CREATE TABLE planning_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL,
  buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (typeof(buffer_minutes) = 'integer' AND buffer_minutes BETWEEN 0 AND 1440),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0 AND revision <= 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE planning_working_hours (
  settings_id INTEGER NOT NULL REFERENCES planning_settings(id) ON DELETE CASCADE CHECK (settings_id = 1),
  weekday INTEGER NOT NULL CHECK (typeof(weekday) = 'integer' AND weekday BETWEEN 1 AND 7),
  start_time TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time < '24:00'),
  end_time TEXT NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time < '24:00' AND end_time > start_time),
  PRIMARY KEY (settings_id, weekday, start_time)
);
