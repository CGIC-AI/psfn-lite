import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createIcpFeltImpulseInitiationAdapter } from '../../core/icp/felt-impulse-initiation.js';
import { createEmoSimProactivityPort } from '../../core/emotion/emosim-proactivity-port.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresIcpFeltImpulseFunnelStore } from './icp-felt-impulse-funnel-store.js';
import { createDefaultEmoSimProactivitySettings } from '../../system/config/runtime-config-contracts.js';

const TIMEOUT_MS = 120_000;
const SCHEMA = 'companion_funnel';
const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-08-17T00:00:00.000Z');
const MINUTE_MS = 60_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, TIMEOUT_MS);

describe('Postgres felt-impulse funnel outcomes', () => {
  it('preserves exactly-once content-free outcomes and candidate lifecycle across restart', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'icp-felt-impulse-funnel-bootstrap',
      allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    let funnel = await PostgresIcpFeltImpulseFunnelStore.connect(databaseUrl, {
      schema: SCHEMA,
    });
    try {
      const firstCrossingMs = T0 - 60 * MINUTE_MS;
      const producerFiredAtMs = firstCrossingMs + 30 * MINUTE_MS;
      const adapter = createIcpFeltImpulseInitiationAdapter({
        sourceRuntime: { accept: async () => { throw new Error('no eligible peer expected'); } },
        peers: { listKnownPeerAvailability: async () => [] },
        isAuthorized: () => true,
        funnelStore: funnel,
        now: () => producerFiredAtMs,
      });
      let proactivityState = {
        firstCrossingMs: null as number | null,
        lastFiredAtMs: null as number | null,
        lastSampledAtMs: null as number | null,
        lastInputId: null as string | null,
      };
      const producer = createEmoSimProactivityPort({
        enabled: true,
        companionId: LOCAL_ID,
        thresholdProfile: {
          ...createDefaultEmoSimProactivitySettings().thresholdProfile,
          profileId: 'would-message-v1',
          socialNeedThreshold: 0.7,
          attachmentIntensityThreshold: 0.5,
          sustainMs: 30 * MINUTE_MS,
          cooldownMs: 6 * 60 * MINUTE_MS,
        },
        stateStore: {
          load: async () => structuredClone(proactivityState),
          save: async state => { proactivityState = structuredClone(state); },
        },
        emitImpulse: impulse => adapter.onImpulse(impulse).then(() => undefined),
      });
      const observe = (observedAtMs: number) => producer.observe({
        companionId: LOCAL_ID,
        observedAtMs,
        source: {
          model: 'emo_sim',
          version: 'emo_sim/server.py#http-api.v1',
          availability: 'available',
          confidence: 0.82,
        },
        lineage: {
          schemaVersion: 1,
          inputId: `turn:${observedAtMs}`,
          projectionVersion: 'psfn.observer-sidecar.appraisal-projection.v3',
          privacyClass: 'content_redacted',
          rawContentRedacted: true,
        },
        snapshot: {
          dominant: 'Calmness',
          emotions: { Calmness: 0.3 },
          drives: { socialNeed: 0.8 },
        },
      });
      await observe(firstCrossingMs);
      await observe(producerFiredAtMs);
      await expect(funnel.getOutcome(
        `felt-impulse:would_message:${firstCrossingMs}`,
      )).resolves.toEqual({
        correlationId: `felt-impulse:would_message:${firstCrossingMs}`,
        firstCrossingMs,
        firedAtMs: producerFiredAtMs,
        recordedAtMs: producerFiredAtMs,
        outcome: 'no_eligible_peer',
      });

      const noPeer = {
        correlationId: `felt-impulse:would_message:${T0}`,
        firstCrossingMs: T0,
        firedAtMs: T0,
        recordedAtMs: T0 + 10,
        outcome: 'no_eligible_peer' as const,
      };
      await expect(funnel.recordOutcome(noPeer)).resolves.toEqual(noPeer);
      await expect(funnel.recordOutcome({
        ...noPeer,
        recordedAtMs: T0 + 20,
        outcome: 'not_authorized',
      })).resolves.toEqual(noPeer);
      const notAuthorized = {
        correlationId: `felt-impulse:would_message:${T0 + 100}`,
        firstCrossingMs: T0 + 100,
        firedAtMs: T0 + 100,
        recordedAtMs: T0 + 110,
        outcome: 'not_authorized' as const,
      };
      const throttled = {
        correlationId: `felt-impulse:would_message:${T0 + 200}`,
        firstCrossingMs: T0 + 200,
        firedAtMs: T0 + 200,
        recordedAtMs: T0 + 210,
        outcome: 'throttled' as const,
        nextEligibleAtMs: T0 + 60_000,
      };
      await funnel.recordOutcome(notAuthorized);
      await funnel.recordOutcome(throttled);

      await funnel.close();
      funnel = await PostgresIcpFeltImpulseFunnelStore.connect(databaseUrl, { schema: SCHEMA });

      await expect(funnel.getOutcome(noPeer.correlationId)).resolves.toEqual(noPeer);
      const inspect = createPostgresPool(databaseUrl, {
        applicationName: 'icp-felt-impulse-funnel-inspect',
        allowExitOnIdle: true,
        schema: SCHEMA,
      });
      try {
        const columns = await inspect.query<{ column_name: string }>(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'icp_felt_impulse_funnel_outcomes'
          ORDER BY column_name
        `, [SCHEMA]);
        expect(columns.rows.map(row => row.column_name)).not.toContain('reason_summary');
        expect(columns.rows.map(row => row.column_name)).not.toContain('reason');
      } finally {
        await inspect.end();
      }
    } finally {
      await Promise.allSettled([funnel.close()]);
    }
  }, TIMEOUT_MS);
});
