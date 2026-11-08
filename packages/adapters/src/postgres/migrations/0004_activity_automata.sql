-- Activity, bounded workers, free time and self-scheduled time: the activity
-- log, worker runs with their effect receipts, extend-only rest per lane,
-- free-time blocks, scheduled self-prompts, reflection templates and care
-- reminders. Records are JSONB documents in core's shape; columns exist only
-- for keys, ordering, list predicates and the constraints the database
-- enforces. Status and state columns are checked against the record, so a
-- filtered list never disagrees with what it returns. Nothing here refers to
-- the tables of earlier migrations.

CREATE TABLE activities (
  activity_id  text PRIMARY KEY,
  revision     integer NOT NULL CHECK (revision > 0),
  status       text NOT NULL CHECK (status = record ->> 'status'),
  started_at   timestamptz NOT NULL,
  record       jsonb NOT NULL
);
CREATE INDEX activities_by_start ON activities (started_at DESC, activity_id DESC);

CREATE TABLE worker_runs (
  run_id       text PRIMARY KEY,
  revision     integer NOT NULL CHECK (revision > 0),
  status       text NOT NULL CHECK (status = record ->> 'status'),
  created_at   timestamptz NOT NULL,
  -- The lease end while the run is held; null when no attempt holds it.
  lease_until  timestamptz,
  activity_id  text NOT NULL REFERENCES activities (activity_id) CHECK (activity_id = record ->> 'activityId'),
  record       jsonb NOT NULL,
  CHECK ((lease_until IS NULL) = (jsonb_typeof(record -> 'lease') IS DISTINCT FROM 'object'))
);
CREATE INDEX worker_runs_by_creation ON worker_runs (created_at DESC, run_id DESC);
CREATE INDEX worker_runs_by_status_creation ON worker_runs (status, created_at DESC, run_id DESC);
CREATE INDEX worker_runs_by_lease ON worker_runs (lease_until) WHERE status = 'running';

-- One receipt per run and host-supplied effect key: written `started` before the effect runs, settled once.
CREATE TABLE worker_effects (
  run_id      text NOT NULL REFERENCES worker_runs (run_id),
  effect_key  text NOT NULL,
  phase       text NOT NULL CHECK (phase IN ('started', 'applied', 'rejected', 'outcome_unknown') AND phase = record ->> 'phase'),
  started_at  timestamptz NOT NULL,
  record      jsonb NOT NULL,
  PRIMARY KEY (run_id, effect_key)
);

-- Extend-only: a write only ever moves `until` later.
CREATE TABLE rest_states (
  lane    text PRIMARY KEY,
  until   timestamptz NOT NULL,
  record  jsonb NOT NULL
);

CREATE TABLE free_time_blocks (
  block_id     text PRIMARY KEY,
  lane         text NOT NULL CHECK (lane = record ->> 'lane'),
  revision     integer NOT NULL CHECK (revision > 0),
  state        text NOT NULL CHECK (state = record ->> 'state'),
  invited_at   timestamptz NOT NULL,
  activity_id  text REFERENCES activities (activity_id) CHECK (activity_id IS NOT DISTINCT FROM record ->> 'activityId'),
  record       jsonb NOT NULL
);
CREATE INDEX free_time_blocks_by_lane ON free_time_blocks (lane, invited_at DESC, block_id DESC);

CREATE TABLE scheduled_prompts (
  prompt_id  text PRIMARY KEY,
  revision   integer NOT NULL CHECK (revision > 0),
  state      text NOT NULL CHECK (state = record ->> 'state'),
  run_at     timestamptz NOT NULL,
  record     jsonb NOT NULL
);
CREATE INDEX scheduled_prompts_by_run ON scheduled_prompts (run_at, prompt_id);
CREATE INDEX scheduled_prompts_by_state_run ON scheduled_prompts (state, run_at, prompt_id);

CREATE TABLE reflection_templates (
  template_id  text PRIMARY KEY,
  revision     integer NOT NULL CHECK (revision > 0),
  record       jsonb NOT NULL
);

CREATE TABLE care_reminders (
  reminder_id  text PRIMARY KEY,
  revision     integer NOT NULL CHECK (revision > 0),
  state        text NOT NULL CHECK (state = record ->> 'state'),
  due_at       timestamptz NOT NULL,
  record       jsonb NOT NULL
);
CREATE INDEX care_reminders_by_due ON care_reminders (due_at, reminder_id);
CREATE INDEX care_reminders_by_state_due ON care_reminders (state, due_at, reminder_id);
