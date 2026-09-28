-- Synthetic DSH 0.1.1-rc.2 fixture, generated through the public Session API.
PRAGMA application_id = 1146308688;
PRAGMA user_version = 17;
CREATE TABLE events (
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  type              TEXT NOT NULL,
  time              INTEGER NOT NULL,
  data              ANY NOT NULL,
  source_event_seqs ANY,
  surface_op        TEXT,
  ignorable         INTEGER CHECK (ignorable IS NULL OR ignorable IN (0, 1)),
  PRIMARY KEY (session_id, seq)
) STRICT;
INSERT INTO "events" VALUES ('synthetic-upgrade-session', 0, 'turn/start', 1790579332550, '{"turn":1}', NULL, NULL, NULL);
INSERT INTO "events" VALUES ('synthetic-upgrade-session', 1, 'turn/end', 1790579332550, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, NULL);
CREATE TABLE persistence_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id  TEXT NOT NULL
) STRICT;
INSERT INTO "persistence_state" VALUES (1, 'a07d0a9b-43ef-4451-8876-32a2fc2d37fd');
CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  version          INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  cwd              TEXT,
  parent_session   TEXT,
  seed_length      INTEGER,
  origin           TEXT,
  delegation_depth INTEGER,
  agent_preset     TEXT,
  incarnation      TEXT NOT NULL,
  revision         INTEGER NOT NULL
) STRICT;
INSERT INTO "sessions" VALUES ('synthetic-upgrade-session', 0, 1790579332549, NULL, NULL, NULL, NULL, NULL, NULL, 'c4c8d0c1-07a5-4f2f-a3a9-87c174fc2de5', 1);
