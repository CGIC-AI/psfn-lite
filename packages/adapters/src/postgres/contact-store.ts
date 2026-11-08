/**
 * Postgres contact store. Policy (trust, consent, merge rules) is core's; the
 * store enforces compare-and-set revisions, that a channel identity belongs to
 * at most one contact (the `contact_identities` primary key), and that every
 * write lands together with its audit change in one transaction.
 */
import type pg from 'pg';
import {
  conflict,
  invalid,
  notFound,
  ok,
  type ContactChange,
  type ContactId,
  type ContactNote,
  type ContactRecord,
  type ContactStorePort,
  type Result,
} from '../core.ts';
import { guarded, records, transaction, type Queryable } from './database.ts';

const UNIQUE = {
  contacts_pkey: 'already_exists',
  contact_identities_pkey: 'identity_conflict',
  contact_notes_id_unique: 'already_exists',
} as const;

export function createPostgresContactStore(pool: pg.Pool): ContactStorePort {
  const lockRevision = async (client: Queryable, contactId: ContactId): Promise<number | null> => {
    const found = await client.query<{ revision: number }>('SELECT revision FROM contacts WHERE contact_id = $1 FOR UPDATE', [contactId]);
    return found.rows[0]?.revision ?? null;
  };

  /** Makes the identity index match the record, refusing identities held by another contact. */
  const syncIdentities = async (client: Queryable, record: ContactRecord): Promise<Result<void>> => {
    const keys = record.identities.map((i) => `${i.channelKind}\u0000${i.externalId}`);
    if (new Set(keys).size !== keys.length) return invalid(`contact ${record.contactId} lists an identity twice`);
    await client.query(
      `DELETE FROM contact_identities
        WHERE contact_id = $1 AND (channel_kind, external_id) NOT IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
      [record.contactId, record.identities.map((i) => i.channelKind), record.identities.map((i) => i.externalId)],
    );
    for (const identity of record.identities) {
      const owner = await client.query<{ contact_id: string }>(
        `INSERT INTO contact_identities (channel_kind, external_id, contact_id) VALUES ($1, $2, $3)
           ON CONFLICT (channel_kind, external_id) DO UPDATE SET contact_id = contact_identities.contact_id
         RETURNING contact_id`,
        [identity.channelKind, identity.externalId, record.contactId],
      );
      const holder = owner.rows[0]?.contact_id;
      if (holder !== record.contactId) {
        return conflict('identity_conflict', `${identity.channelKind}:${identity.externalId} belongs to ${holder ?? 'another contact'}`);
      }
    }
    return ok(undefined);
  };

  const audit = (client: Queryable, contactId: ContactId, change: ContactChange) =>
    client.query('INSERT INTO contact_changes (contact_id, record) VALUES ($1, $2)', [contactId, change]);

  return {
    get: (contactId) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM contacts WHERE contact_id = $1', [contactId]);
        const record = records<ContactRecord>(found.rows)[0];
        return record === undefined ? notFound(`contact ${contactId}`) : ok(record);
      }),

    findByIdentity: (identity) =>
      guarded(async () => {
        const found = await pool.query(
          `SELECT c.record FROM contact_identities i JOIN contacts c USING (contact_id)
            WHERE i.channel_kind = $1 AND i.external_id = $2`,
          [identity.channelKind, identity.externalId],
        );
        return ok(records<ContactRecord>(found.rows)[0] ?? null);
      }),

    list: (limit, afterContactId) =>
      guarded(async () => {
        const found =
          afterContactId === null
            ? await pool.query('SELECT record FROM contacts ORDER BY contact_id LIMIT $1', [limit])
            : await pool.query('SELECT record FROM contacts WHERE contact_id > $1 ORDER BY contact_id LIMIT $2', [afterContactId, limit]);
        return ok(records<ContactRecord>(found.rows));
      }),

    create: (record, change) =>
      transaction(
        pool,
        async (client) => {
          await client.query('INSERT INTO contacts (contact_id, revision, record) VALUES ($1, $2, $3)', [record.contactId, record.revision, record]);
          const synced = await syncIdentities(client, record);
          if (!synced.ok) return synced;
          await audit(client, record.contactId, change);
          return ok(record);
        },
        { unique: UNIQUE },
      ),

    save: (record, expectedRevision, change) =>
      transaction(
        pool,
        async (client) => {
          const current = await lockRevision(client, record.contactId);
          if (current === null) return notFound(`contact ${record.contactId}`);
          if (current !== expectedRevision) {
            return conflict('stale_revision', `contact ${record.contactId} moved`, { expectedRevision, actualRevision: current });
          }
          await client.query('UPDATE contacts SET revision = $2, record = $3 WHERE contact_id = $1', [record.contactId, record.revision, record]);
          const synced = await syncIdentities(client, record);
          if (!synced.ok) return synced;
          await audit(client, record.contactId, change);
          return ok(record);
        },
        { unique: UNIQUE },
      ),

    merge: (source, survivor, expected, change) =>
      transaction(
        pool,
        async (client) => {
          if (source.contactId === survivor.contactId) return invalid('a contact cannot merge into itself');
          // Lock in id order so two concurrent merges cannot deadlock.
          const ordered = [source.contactId, survivor.contactId].sort();
          const revisions = new Map<ContactId, number | null>();
          for (const contactId of ordered) revisions.set(contactId, await lockRevision(client, contactId));
          const sourceRevision = revisions.get(source.contactId) ?? null;
          const survivorRevision = revisions.get(survivor.contactId) ?? null;
          if (sourceRevision === null) return notFound(`contact ${source.contactId}`);
          if (survivorRevision === null) return notFound(`contact ${survivor.contactId}`);
          if (sourceRevision !== expected.source || survivorRevision !== expected.survivor) {
            return conflict('stale_revision', 'a merged contact moved');
          }
          await client.query('UPDATE contacts SET revision = $2, record = $3 WHERE contact_id = $1', [source.contactId, source.revision, source]);
          await client.query('UPDATE contacts SET revision = $2, record = $3 WHERE contact_id = $1', [survivor.contactId, survivor.revision, survivor]);
          const releasedSource = await syncIdentities(client, source);
          if (!releasedSource.ok) return releasedSource;
          const claimed = await syncIdentities(client, survivor);
          if (!claimed.ok) return claimed;
          await audit(client, source.contactId, change);
          await audit(client, survivor.contactId, change);
          return ok({ source, survivor });
        },
        { unique: UNIQUE },
      ),

    appendNote: (note) =>
      guarded(
        async () => {
          await pool.query('INSERT INTO contact_notes (note_id, contact_id, record) VALUES ($1, $2, $3)', [note.noteId, note.contactId, note]);
          return ok(note);
        },
        UNIQUE,
      ),

    notes: (contactId, limit) =>
      guarded(async () => {
        const found = await pool.query('SELECT record FROM contact_notes WHERE contact_id = $1 ORDER BY seq DESC LIMIT $2', [contactId, limit]);
        return ok(records<ContactNote>(found.rows));
      }),
  };
}
