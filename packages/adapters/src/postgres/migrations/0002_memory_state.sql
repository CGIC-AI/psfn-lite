-- Memory, episodes, journals, reflections and letters. As in 0001, records
-- are JSONB documents owned by core contracts. Columns exist for keys,
-- ordering, compare-and-set revisions and for the access filter, which the
-- stores apply inside each query before ranking and limits: source
-- conversation and disclosure class, sensitivity, and subject or
-- participants. No column is generated, so a backup restores by plain insert.
--
-- Embeddings are kept per named space with their dimensions. The vector
-- column is unconstrained so a space can change model and size; each row is
-- checked against its declared dimensions, and the stores create one partial
-- HNSW index per configured space when they open.

-- Memories
CREATE TABLE memories (
  seq                  bigint GENERATED ALWAYS AS IDENTITY,
  memory_id            text PRIMARY KEY,
  kind                 text NOT NULL CHECK (kind IN ('fact', 'preference', 'event', 'relational', 'procedural', 'boundary')),
  state                text NOT NULL CHECK (state IN ('current', 'superseded', 'soft_deleted', 'staged', 'rejected')),
  sensitivity          text NOT NULL CHECK (sensitivity IN ('public', 'personal', 'intimate', 'confidential')),
  source_conversation  text NOT NULL,
  source_class         text NOT NULL CHECK (source_class IN ('public', 'personal', 'intimate', 'confidential')),
  subject_key          text NOT NULL,
  subject_kind         text NOT NULL CHECK (subject_kind IN ('contacts', 'room', 'companion_internal')),
  subject_contacts     text[] NOT NULL,
  subject_channel      text,
  revision             integer NOT NULL CHECK (revision > 0),
  record               jsonb NOT NULL,
  CONSTRAINT memories_seq_unique UNIQUE (seq)
);
CREATE INDEX memories_candidates ON memories (subject_key, kind, seq DESC) WHERE state = 'current';
CREATE INDEX memories_by_state ON memories (state, seq);
CREATE INDEX memories_subject_contacts ON memories USING gin (subject_contacts);
CREATE INDEX memories_search ON memories USING gin (to_tsvector('simple'::regconfig, record ->> 'content'));

CREATE TABLE memory_write_receipts (
  idempotency_key  text PRIMARY KEY,
  memory_id        text NOT NULL REFERENCES memories (memory_id),
  record           jsonb NOT NULL
);

CREATE TABLE memory_links (
  seq      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_id  text NOT NULL REFERENCES memories (memory_id),
  to_id    text NOT NULL REFERENCES memories (memory_id),
  record   jsonb NOT NULL
);
CREATE INDEX memory_links_from ON memory_links (from_id);
CREATE INDEX memory_links_to ON memory_links (to_id);

CREATE TABLE memory_events (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  memory_id  text NOT NULL REFERENCES memories (memory_id),
  record     jsonb NOT NULL
);
CREATE INDEX memory_events_by_memory ON memory_events (memory_id, seq DESC);

CREATE TABLE memory_embeddings (
  memory_id   text NOT NULL REFERENCES memories (memory_id),
  space       text NOT NULL,
  dimensions  integer NOT NULL CHECK (dimensions BETWEEN 1 AND 4000),
  embedding   vector NOT NULL,
  PRIMARY KEY (memory_id, space),
  CONSTRAINT memory_embeddings_dimensions CHECK (vector_dims(embedding) = dimensions)
);
CREATE INDEX memory_embeddings_by_space ON memory_embeddings (space);

CREATE TABLE memory_deletion_proposals (
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  proposal_id  text PRIMARY KEY,
  memory_id    text NOT NULL REFERENCES memories (memory_id),
  status       text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'restored')),
  revision     integer NOT NULL CHECK (revision > 0),
  record       jsonb NOT NULL,
  CONSTRAINT memory_deletion_proposals_seq_unique UNIQUE (seq)
);
CREATE INDEX memory_deletion_proposals_by_memory ON memory_deletion_proposals (memory_id, status, seq DESC);

-- Same-day scratchpad; conversation is NULL for a companion-global note
CREATE TABLE scratchpad_notes (
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  note_id       text PRIMARY KEY,
  conversation  text,
  expires_at    timestamptz NOT NULL,
  revision      integer NOT NULL CHECK (revision > 0),
  record        jsonb NOT NULL,
  CONSTRAINT scratchpad_notes_seq_unique UNIQUE (seq)
);
CREATE INDEX scratchpad_notes_live ON scratchpad_notes (conversation, expires_at);

-- Per-session processing watermarks (memory extraction, episode formation)
CREATE TABLE session_cursors (
  purpose     text NOT NULL CHECK (purpose IN ('memory_extraction', 'episode_formation')),
  session_id  text NOT NULL,
  seq         integer NOT NULL CHECK (seq >= 0),
  revision    integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (purpose, session_id)
);

-- Episodes and arcs
CREATE TABLE episodes (
  seq                  bigint GENERATED ALWAYS AS IDENTITY,
  episode_id           text PRIMARY KEY,
  lifecycle            text NOT NULL CHECK (lifecycle IN ('candidate', 'canonical', 'merged')),
  source_conversation  text NOT NULL,
  source_class         text NOT NULL CHECK (source_class IN ('public', 'personal', 'intimate', 'confidential')),
  source_channel       text,
  participants         text[] NOT NULL,
  occurred_from        timestamptz NOT NULL,
  occurred_to          timestamptz NOT NULL,
  revision             integer NOT NULL CHECK (revision > 0),
  record               jsonb NOT NULL,
  CONSTRAINT episodes_seq_unique UNIQUE (seq),
  CONSTRAINT episodes_span CHECK (occurred_from <= occurred_to)
);
CREATE INDEX episodes_by_conversation ON episodes (source_conversation, occurred_from) WHERE lifecycle <> 'merged';
CREATE INDEX episodes_by_time ON episodes (occurred_from, occurred_to);
CREATE INDEX episodes_participants ON episodes USING gin (participants);
CREATE INDEX episodes_search ON episodes USING gin (
  to_tsvector('simple'::regconfig, coalesce(record -> 'machineSignals' ->> 'summary', '') || ' ' || coalesce(record -> 'meaning' ->> 'text', ''))
);

-- Every version of the companion's meaning, kept when it is revised
CREATE TABLE episode_meanings (
  episode_id  text NOT NULL REFERENCES episodes (episode_id),
  revision    integer NOT NULL CHECK (revision > 0),
  record      jsonb NOT NULL,
  PRIMARY KEY (episode_id, revision)
);

CREATE TABLE episode_embeddings (
  episode_id  text NOT NULL REFERENCES episodes (episode_id),
  space       text NOT NULL,
  dimensions  integer NOT NULL CHECK (dimensions BETWEEN 1 AND 4000),
  embedding   vector NOT NULL,
  PRIMARY KEY (episode_id, space),
  CONSTRAINT episode_embeddings_dimensions CHECK (vector_dims(embedding) = dimensions)
);
CREATE INDEX episode_embeddings_by_space ON episode_embeddings (space);

CREATE TABLE episode_arcs (
  arc_id    text PRIMARY KEY,
  revision  integer NOT NULL CHECK (revision > 0),
  record    jsonb NOT NULL
);

CREATE TABLE episode_arc_members (
  arc_id      text NOT NULL REFERENCES episode_arcs (arc_id),
  episode_id  text NOT NULL REFERENCES episodes (episode_id),
  position    integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (arc_id, episode_id)
);
CREATE INDEX episode_arc_members_by_episode ON episode_arc_members (episode_id);

-- Journal notes; a restricted note has no source conversation
CREATE TABLE journal_notes (
  path                 text PRIMARY KEY,
  scope                text NOT NULL CHECK (scope IN ('conversation', 'restricted')),
  source_conversation  text,
  source_class         text CHECK (source_class IN ('public', 'personal', 'intimate', 'confidential')),
  revision             integer NOT NULL CHECK (revision > 0),
  record               jsonb NOT NULL,
  CONSTRAINT journal_notes_source CHECK ((scope = 'restricted') = (source_conversation IS NULL AND source_class IS NULL))
);
CREATE INDEX journal_notes_search ON journal_notes USING gin (to_tsvector('simple'::regconfig, record ->> 'body'));

CREATE TABLE reflections (
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  reflection_id  text PRIMARY KEY,
  record         jsonb NOT NULL,
  CONSTRAINT reflections_seq_unique UNIQUE (seq)
);

-- Letters and their lived history
CREATE TABLE letters (
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  letter_id  text PRIMARY KEY,
  author     text NOT NULL CHECK (author IN ('companion', 'partner')),
  recipient  text NOT NULL CHECK (recipient IN ('companion', 'partner')),
  state      text NOT NULL CHECK (state IN ('draft', 'placed', 'read', 'archived')),
  revision   integer NOT NULL CHECK (revision > 0),
  record     jsonb NOT NULL,
  CONSTRAINT letters_seq_unique UNIQUE (seq)
);

CREATE TABLE letter_events (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  letter_id  text NOT NULL REFERENCES letters (letter_id),
  record     jsonb NOT NULL
);
CREATE INDEX letter_events_by_letter ON letter_events (letter_id, seq DESC);
