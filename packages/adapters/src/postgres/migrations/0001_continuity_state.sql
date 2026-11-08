-- Structured continuity state: turns, sessions, contacts, consent, identity,
-- values and North Star. Records are stored as JSONB documents owned by core
-- contracts; columns exist only for keys, ordering and constraints the
-- database must enforce (compare-and-set revisions and uniqueness).
-- Canonical lived history is NOT here: it lives in the JSONL archive. The
-- transcript tables are a derived, rebuildable projection of it.

CREATE EXTENSION IF NOT EXISTS vector;

-- Turn ledger
CREATE TABLE session_heads (
  session_id    text PRIMARY KEY,
  revision      integer NOT NULL CHECK (revision >= 0),
  open_turn_id  text
);

CREATE TABLE turns (
  turn_id          text PRIMARY KEY,
  session_id       text NOT NULL,
  idempotency_key  text NOT NULL,
  record           jsonb NOT NULL,
  CONSTRAINT turns_idempotency_unique UNIQUE (session_id, idempotency_key)
);

-- Session catalog
CREATE TABLE sessions (
  session_id        text PRIMARY KEY,
  last_activity_at  timestamptz NOT NULL,
  record            jsonb NOT NULL
);
CREATE INDEX sessions_by_activity ON sessions (last_activity_at DESC, session_id DESC);

CREATE TABLE conversation_heads (
  conversation  text PRIMARY KEY,
  session_id    text NOT NULL REFERENCES sessions (session_id),
  revision      integer NOT NULL CHECK (revision > 0)
);

CREATE TABLE continuity_artifacts (
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id          text NOT NULL CONSTRAINT continuity_artifacts_id_unique UNIQUE,
  session_id  text NOT NULL,
  record      jsonb NOT NULL
);
CREATE INDEX continuity_artifacts_by_session ON continuity_artifacts (session_id, seq DESC);

CREATE TABLE focus_records (
  focus_id    text PRIMARY KEY,
  session_id  text NOT NULL,
  completed   boolean NOT NULL,
  record      jsonb NOT NULL
);
CREATE UNIQUE INDEX focus_records_one_open ON focus_records (session_id) WHERE NOT completed;

-- Derived transcript projection (excluded from backups; rebuilt from the canon)
CREATE TABLE transcript_watermarks (
  session_id  text PRIMARY KEY,
  count       integer NOT NULL CHECK (count >= 0),
  hash        text
);

CREATE TABLE transcript_entries (
  session_id  text NOT NULL,
  seq         integer NOT NULL CHECK (seq > 0),
  hash        text NOT NULL,
  entry       jsonb NOT NULL,
  search      tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, entry ->> 'text')) STORED,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX transcript_entries_search ON transcript_entries USING gin (search);

-- Contacts and consent
CREATE TABLE contacts (
  contact_id  text PRIMARY KEY,
  revision    integer NOT NULL CHECK (revision >= 0),
  record      jsonb NOT NULL
);

CREATE TABLE contact_identities (
  channel_kind  text NOT NULL,
  external_id   text NOT NULL,
  contact_id    text NOT NULL REFERENCES contacts (contact_id),
  PRIMARY KEY (channel_kind, external_id)
);
CREATE INDEX contact_identities_by_contact ON contact_identities (contact_id);

CREATE TABLE contact_changes (
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id  text NOT NULL REFERENCES contacts (contact_id),
  record      jsonb NOT NULL
);

CREATE TABLE contact_notes (
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_id     text NOT NULL CONSTRAINT contact_notes_id_unique UNIQUE,
  contact_id  text NOT NULL REFERENCES contacts (contact_id),
  record      jsonb NOT NULL
);
CREATE INDEX contact_notes_by_contact ON contact_notes (contact_id, seq DESC);

-- Identity: orientation blocks, prompt layers, persona
CREATE TABLE core_blocks (
  channel_id  text NOT NULL,
  name        text NOT NULL CHECK (name IN ('persona', 'human', 'goals')),
  revision    integer NOT NULL CHECK (revision > 0),
  record      jsonb NOT NULL,
  PRIMARY KEY (channel_id, name)
);

CREATE TABLE prompt_layers (
  layer_id         text PRIMARY KEY,
  name             text NOT NULL,
  type             text NOT NULL CHECK (type IN ('base', 'operator', 'system_language', 'runtime', 'channel', 'task')),
  current_version  integer NOT NULL CHECK (current_version > 0)
);

CREATE TABLE prompt_layer_versions (
  layer_id  text NOT NULL REFERENCES prompt_layers (layer_id),
  version   integer NOT NULL CHECK (version > 0),
  record    jsonb NOT NULL,
  PRIMARY KEY (layer_id, version)
);

CREATE TABLE persona_versions (
  version  integer PRIMARY KEY CHECK (version > 0),
  record   jsonb NOT NULL
);

-- Values and North Star
CREATE TABLE value_entries (
  version  integer PRIMARY KEY CHECK (version > 0),
  record   jsonb NOT NULL
);

CREATE TABLE north_star_state (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision   integer NOT NULL CHECK (revision > 0),
  items      jsonb NOT NULL
);

CREATE TABLE north_star_item_versions (
  item_id         text NOT NULL,
  version         integer NOT NULL CHECK (version > 0),
  saved_revision  integer NOT NULL,
  reason          text NOT NULL,
  record          jsonb NOT NULL,
  PRIMARY KEY (item_id, version)
);
