-- Self-state continuity: per-scope emotion state with its meaningful-change
-- gate and self-model, the once-only observation log, machine appraisals,
-- companion self-reports, concerns with their append-only event history, and
-- pending follow-ups. Records are JSONB documents in core's shape; columns
-- exist only for keys, ordering, list predicates and the constraints the
-- database enforces. The status and state columns are checked against the
-- record, so a filtered list never disagrees with what it returns.

CREATE TABLE emotion_states (
  scope_key  text PRIMARY KEY,
  revision   integer NOT NULL CHECK (revision > 0),
  record     jsonb NOT NULL
);

-- One row per applied source (turn or concern resolution), so a retry never applies twice.
CREATE TABLE emotion_observations (
  observation_id  text PRIMARY KEY,
  scope_key       text NOT NULL REFERENCES emotion_states (scope_key),
  record          jsonb NOT NULL
);

CREATE TABLE emotion_appraisals (
  seq           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appraisal_id  text NOT NULL CONSTRAINT emotion_appraisals_id_unique UNIQUE,
  record        jsonb NOT NULL
);

CREATE TABLE emotion_self_reports (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_id  text NOT NULL CONSTRAINT emotion_self_reports_id_unique UNIQUE,
  scope_key  text NOT NULL,
  record     jsonb NOT NULL
);
CREATE INDEX emotion_self_reports_by_scope ON emotion_self_reports (scope_key, seq DESC);

CREATE TABLE concerns (
  concern_id  text PRIMARY KEY,
  revision    integer NOT NULL CHECK (revision > 0),
  status      text NOT NULL CHECK (status = record ->> 'status'),
  updated_at  timestamptz NOT NULL,
  record      jsonb NOT NULL
);
CREATE INDEX concerns_by_update ON concerns (updated_at DESC, concern_id DESC);
CREATE INDEX concerns_by_status_update ON concerns (status, updated_at DESC, concern_id DESC);

CREATE TABLE concern_events (
  concern_id  text NOT NULL REFERENCES concerns (concern_id),
  revision    integer NOT NULL CHECK (revision > 0),
  record      jsonb NOT NULL,
  PRIMARY KEY (concern_id, revision)
);

CREATE TABLE follow_ups (
  follow_up_id  text PRIMARY KEY,
  revision      integer NOT NULL CHECK (revision > 0),
  state         text NOT NULL CHECK (state = record ->> 'state'),
  due_at        timestamptz NOT NULL,
  record        jsonb NOT NULL
);
CREATE INDEX follow_ups_by_due ON follow_ups (due_at, follow_up_id);
CREATE INDEX follow_ups_by_state_due ON follow_ups (state, due_at, follow_up_id);
