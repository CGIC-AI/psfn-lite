/**
 * Postgres implementations of the free-time and self-scheduling ports:
 * extend-only rest per lane (the database only ever moves `until` later),
 * free-time blocks, scheduled self-prompts, reflection templates and care
 * reminders. Every update is compare-and-set on the record's revision.
 */
import type pg from 'pg';
import {
  conflict,
  invalid,
  ok,
  type CareReminder,
  type CareReminderPort,
  type FreeTimeBlock,
  type FreeTimeBlockPort,
  type ReflectionTemplate,
  type ReflectionTemplatePort,
  type RestDecision,
  type RestStatePort,
  type ScheduledPrompt,
  type ScheduledPromptPort,
} from '../core.ts';
import { guarded, records } from './database.ts';
import { getOne, insertNew, insertOnce, updateAt, type RecordTable } from './record-rows.ts';

const BLOCKS: RecordTable = { table: 'free_time_blocks', key: 'block_id', what: 'free-time block' };
const PROMPTS: RecordTable = { table: 'scheduled_prompts', key: 'prompt_id', what: 'scheduled prompt' };
const TEMPLATES: RecordTable = { table: 'reflection_templates', key: 'template_id', what: 'reflection template' };
const REMINDERS: RecordTable = { table: 'care_reminders', key: 'reminder_id', what: 'care reminder' };

export function createPostgresRestState(pool: pg.Pool): RestStatePort {
  return {
    read: (lane) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM rest_states WHERE lane = $1', [lane]);
        return ok(records<RestDecision>(found.rows)[0] ?? null);
      }),
    extend: (lane, decision) =>
      guarded(async () => {
        await pool.query(
          `INSERT INTO rest_states (lane, until, record) VALUES ($1, $2, $3)
           ON CONFLICT (lane) DO UPDATE SET until = EXCLUDED.until, record = EXCLUDED.record WHERE rest_states.until < EXCLUDED.until`,
          [lane, decision.until, decision],
        );
        const found = await pool.query('SELECT record FROM rest_states WHERE lane = $1', [lane]);
        return ok(records<RestDecision>(found.rows)[0] ?? decision);
      }),
  };
}

const blockColumns = (block: FreeTimeBlock) => ({ state: block.state, activity_id: block.activityId });

export function createPostgresFreeTimeBlocks(pool: pg.Pool): FreeTimeBlockPort {
  return {
    // The one-open-block index raises a unique violation outside ON CONFLICT (block_id); it reads as an open invitation.
    create: (block) =>
      insertNew(pool, BLOCKS, block.id, block, { lane: block.lane, revision: block.revision, invited_at: block.invitedAt, ...blockColumns(block) }, {
        free_time_blocks_one_open: 'turn_already_open',
      }),
    get: (id) => getOne<FreeTimeBlock>(pool, BLOCKS, id),
    recent: (lane, limit) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM free_time_blocks WHERE lane = $1 ORDER BY invited_at DESC, block_id DESC LIMIT $2', [lane, limit]);
        return ok(records<FreeTimeBlock>(found.rows));
      }),
    // The lane column is checked against the record, so a block can never change lane.
    update: (next, expectedRevision) => updateAt(pool, BLOCKS, next.id, next, expectedRevision, blockColumns(next)),
  };
}

export function createPostgresScheduledPrompts(pool: pg.Pool): ScheduledPromptPort {
  return {
    create: async (prompt) => {
      const created = await insertOnce(pool, PROMPTS, prompt.id, prompt, { revision: prompt.revision, state: prompt.state, run_at: prompt.runAt });
      return created.ok ? ok({ prompt: created.value.record, created: created.value.created }) : created;
    },
    get: (id) => getOne<ScheduledPrompt>(pool, PROMPTS, id),
    list: ({ states, dueAtOrBefore, limit, after }) =>
      guarded(async () => {
        const found = await pool.query(
          `SELECT record FROM scheduled_prompts
            WHERE ($1::text[] IS NULL OR state = ANY($1))
              AND ($2::timestamptz IS NULL OR run_at <= $2)
              AND ($3::timestamptz IS NULL OR (run_at, prompt_id) > ($3::timestamptz, $4::text))
            ORDER BY run_at, prompt_id
            LIMIT $5`,
          [states === null ? null : [...states], dueAtOrBefore, after?.runAt ?? null, after?.id ?? null, limit],
        );
        return ok(records<ScheduledPrompt>(found.rows));
      }),
    update: (next, expectedRevision) => updateAt(pool, PROMPTS, next.id, next, expectedRevision, { state: next.state, run_at: next.runAt }),
  };
}

export function createPostgresReflectionTemplates(pool: pg.Pool): ReflectionTemplatePort {
  return {
    get: (id) => getOne<ReflectionTemplate>(pool, TEMPLATES, id),
    list: (limit) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM reflection_templates ORDER BY template_id LIMIT $1', [limit]);
        return ok(records<ReflectionTemplate>(found.rows));
      }),
    put: async (next, expectedRevision) => {
      if (expectedRevision !== 0) return updateAt(pool, TEMPLATES, next.id, next, expectedRevision, {});
      if (next.revision !== 1) return invalid('a new reflection template starts at revision 1');
      // A racing create loses as a stale revision, as a moved template would.
      const created = await insertOnce(pool, TEMPLATES, next.id, next, { revision: next.revision });
      if (!created.ok) return created;
      return created.value.created ? ok(next) : conflict('stale_revision', `reflection template ${next.id} already exists`, { expectedRevision, actualRevision: created.value.record.revision });
    },
  };
}

export function createPostgresCareReminders(pool: pg.Pool): CareReminderPort {
  return {
    create: async (reminder) => {
      const created = await insertOnce(pool, REMINDERS, reminder.id, reminder, { revision: reminder.revision, state: reminder.state, due_at: reminder.dueAt });
      return created.ok ? ok({ reminder: created.value.record, created: created.value.created }) : created;
    },
    get: (id) => getOne<CareReminder>(pool, REMINDERS, id),
    list: ({ states, dueAtOrBefore, limit, after }) =>
      guarded(async () => {
        const found = await pool.query(
          `SELECT record FROM care_reminders
            WHERE ($1::text[] IS NULL OR state = ANY($1))
              AND ($2::timestamptz IS NULL OR due_at <= $2)
              AND ($3::timestamptz IS NULL OR (due_at, reminder_id) > ($3::timestamptz, $4::text))
            ORDER BY due_at, reminder_id
            LIMIT $5`,
          [states === null ? null : [...states], dueAtOrBefore, after?.dueAt ?? null, after?.id ?? null, limit],
        );
        return ok(records<CareReminder>(found.rows));
      }),
    update: (next, expectedRevision) => updateAt(pool, REMINDERS, next.id, next, expectedRevision, { state: next.state, due_at: next.dueAt }),
  };
}
