import { describe, expect, it } from 'vitest';
import {
  BASELINE_EMOTION_POLICY,
  TOOL_INVENTORY,
  deriveWorkerScope,
  unavailable,
  type ActiveConcern,
  type AppraisalEntry,
  type ConcernTransitionOutcome,
  type EmotionReading,
  type PendingFollowUp,
  type TrustedTurnScope,
  type WorkerRunId,
} from '../../packages/core/src/index.ts';
import { PI } from './fakes.ts';
import { reading, steady } from './self-state-fakes.ts';
import { selfStateWorld, wireSelfState } from './self-state-world.ts';

const errorOf = (result: { ok: boolean; error?: unknown }) => (result.ok ? 'ok' : result.error);
const contentOf = <T>(result: { ok: boolean; value?: { content: unknown } }): T => {
  if (!result.ok || result.value === undefined) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.value.content as T;
};

function workerOf(scope: TrustedTurnScope, actions: { tool: string; action: string }[], maxSensitivity: 'public' | 'personal' | 'confidential' = 'personal') {
  const derived = deriveWorkerScope(scope, 'run-1' as WorkerRunId, { actions, maxTurns: 1, maxSensitivity });
  if (!derived.ok) throw new Error(JSON.stringify(derived.error));
  return derived.value;
}

describe('emotion state and the meaningful-change gate', () => {
  it('skips appraisal for stable input and pays for one only when the state really moves', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    const first = await w.talk(robin, 'hello', 'hi there', 'k1', steady());
    expect(first.observed).toEqual({ status: 'observed', trusted: true, gate: 'baseline_seeded', appraisal: null, inference: { estimator: 1, model: 0 } });
    for (const key of ['k2', 'k3', 'k4']) {
      const stable = await w.talk(robin, 'still here', 'me too', key, steady());
      expect(stable.observed).toMatchObject({ gate: 'no_movement', inference: { estimator: 1, model: 0 } });
    }
    expect(w.ports.estimator.calls).toHaveLength(4);
    expect(w.ports.appraiser.calls).toHaveLength(0);

    const moved = await w.talk(robin, 'my old dog died today', 'I am so sorry, Robin', 'k5', reading(-0.8, 0.5, -0.4));
    expect(moved.observed).toMatchObject({ gate: 'appraisal_due', appraisal: { status: 'written' }, inference: { estimator: 1, model: 1 } });
    expect(w.ports.appraiser.calls).toHaveLength(1);
    expect(w.ports.appraiser.calls[0]?.attribution).toEqual({ purpose: 'emotion.appraisal', turnId: moved.turnId, output: 'machine_inference' });
    const appraisal = (moved.observed.appraisal as { entry: AppraisalEntry }).entry;
    expect(appraisal).toMatchObject({ author: { kind: 'machine', producer: 'emotion.appraisal' }, source: robin.audience });
    expect(appraisal.delta).toBeCloseTo(0.72, 9);

    const settled = await w.talk(robin, 'thank you', 'always', 'k6', steady());
    expect(settled.observed).toMatchObject({ gate: 'no_movement', inference: { model: 0 } });
    expect(w.ports.appraiser.calls).toHaveLength(1);
  });

  it('refuses a malformed estimator reading without touching state or the gate', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    await w.talk(robin, 'hello', 'hi there', 'k1', steady());
    const key = `direct:${w.people.primary}`;
    const before = w.ports.emotionStates.states.get(key);
    const malformed: unknown[] = [
      { ...steady(), vad: { valence: Number.NaN, arousal: 0, dominance: 0 }, discrete: { joy: Number.NaN } },
      { ...steady(), vad: { valence: 0.1 } },
      { ...steady(), discrete: { joy: Number.NaN } },
      { ...steady(), discrete: { Joy: 0.5 } },
      { ...steady(), vad: { valence: 3, arousal: 0, dominance: 0 } },
      { ...steady(), confidence: Number.POSITIVE_INFINITY },
      { ...steady(), producer: '' },
      { ...steady(), extra: true },
    ];
    for (const [index, bad] of malformed.entries()) {
      w.ports.estimator.reading = bad as never;
      const sessionId = await w.converse(robin, `turn ${String(index)}`, 'ok', `bad-${String(index)}`);
      const settled = await w.ledger.lastSettled(sessionId);
      if (!settled.ok || settled.value === null) throw new Error('no settled turn');
      const observed = await w.emotion.observeTurn(robin, { turnId: settled.value.turnId, toolCallCount: 0 });
      expect(errorOf(observed), JSON.stringify(bad)).toMatchObject({ kind: 'unavailable', capability: 'affect_estimator' });
      expect(w.ports.emotionStates.observations.has(`turn:${settled.value.turnId}`)).toBe(false);
    }
    expect(w.ports.emotionStates.states.get(key)).toEqual(before);

    // The baseline is still a real reading, so stable turns afterwards stay free of appraisal.
    for (const turnKey of ['k2', 'k3', 'k4']) {
      const stable = await w.talk(robin, 'still here', 'me too', turnKey, steady());
      expect(stable.observed).toMatchObject({ gate: 'no_movement', inference: { estimator: 1, model: 0 } });
    }
    expect(w.ports.appraiser.calls).toHaveLength(0);
  });

  it('replays an observed turn without inference and keeps the gate across a restart', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    await w.talk(robin, 'hello', 'hi', 'k1', steady());

    // The appraisal model is down: the observation is durable and the appraisal stays owed.
    const appraiser = w.ports.appraiser;
    const complete = appraiser.complete.bind(appraiser);
    appraiser.complete = () => Promise.resolve(unavailable('model', 'provider down'));
    const moved = await w.talk(robin, 'bad news', 'oh no', 'k2', reading(-0.8, 0, 0));
    expect(moved.observed).toMatchObject({ gate: 'appraisal_due', appraisal: { status: 'failed', error: { kind: 'unavailable' } } });
    appraiser.complete = complete;

    // A successor harness wires fresh services over the same stores.
    const restarted = wireSelfState(w, w.ports);
    const estimatorCalls = w.ports.estimator.calls.length;
    const replay = await restarted.emotion.observeTurn(robin, { turnId: moved.turnId, toolCallCount: 0 });
    expect(replay.ok && replay.value).toMatchObject({ status: 'replayed', gate: 'appraisal_due', appraisal: { status: 'written' }, inference: { estimator: 0, model: 1 } });
    const again = await restarted.emotion.observeTurn(robin, { turnId: moved.turnId, toolCallCount: 0 });
    expect(again.ok && again.value).toEqual({ status: 'replayed', trusted: true, gate: 'appraisal_due', appraisal: null, inference: { estimator: 0, model: 0 } });
    expect(w.ports.estimator.calls).toHaveLength(estimatorCalls);
    expect(w.ports.appraisals.entries).toHaveLength(1);

    // The persisted baseline is the appraised target, so the first move after restart is measured against it.
    const back = await restarted.talk(robin, 'actually it worked out', 'that is a relief', 'k3', reading(0.8, 0, 0));
    expect(back.observed).toMatchObject({ gate: 'appraisal_due', inference: { model: 1 } });
    expect(w.ports.appraiser.calls).toHaveLength(2);
  });

  it('serves only a trusted, fresh estimate of the current scope, labelled as inference', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    const sam = await w.admit('friend-dm');
    expect(errorOf(await w.call(robin, 'emotion', 'read'))).toMatchObject({ kind: 'not_found' });
    const weak = await w.talk(robin, 'hm', 'hm?', 'k1', steady(0.1));
    expect(weak.observed).toMatchObject({ trusted: false, gate: 'untrusted_telemetry' });
    expect(errorOf(await w.call(robin, 'emotion', 'read'))).toMatchObject({ kind: 'not_found' });

    await w.talk(robin, 'great day at the lake', 'glad to hear it', 'k2', reading(0.6, 0.2, 0.1));
    const read = contentOf<EmotionReading>(await w.call(robin, 'emotion', 'read'));
    expect(read.scope).toEqual({ kind: 'direct', contactId: w.people.primary });
    expect(read.estimate).toMatchObject({ source: 'machine_inference', producer: 'fake-estimator' });
    expect(read.estimate.vad.valence).toBeCloseTo(0.54, 6);
    expect(read.selfModel).toMatchObject({ source: 'machine_inference', salientTerms: expect.arrayContaining(['lake']) as unknown });
    expect(read.latestSelfReport).toBeNull();
    // Another contact's DM is another scope; nothing of Robin's shows there.
    expect(errorOf(await w.call(sam, 'emotion', 'read'))).toMatchObject({ kind: 'not_found' });

    w.clock.advance(BASELINE_EMOTION_POLICY.freshForMs + 1);
    expect(errorOf(await w.call(robin, 'emotion', 'read'))).toMatchObject({ kind: 'not_found' });
  });

  it('keeps self-reports companion-authored and apart from estimates', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    const sam = await w.admit('friend-dm');
    await w.talk(robin, 'how are you?', 'good', 'k1', reading(0.3, 0, 0));
    const before = contentOf<EmotionReading>(await w.call(robin, 'emotion', 'read'));
    const report = await w.selfReport(robin, 'I feel calm, if a little tired');
    expect(report).toMatchObject({ source: 'companion_authored', author: { kind: 'companion' }, supersedes: null, audience: robin.audience });
    const after = contentOf<EmotionReading>(await w.call(robin, 'emotion', 'read'));
    expect(after.estimate).toEqual(before.estimate);
    expect(after.latestSelfReport).toEqual(report);

    const correction = await w.call(robin, 'emotion', 'self_report', { text: 'More tired than calm, honestly', supersedes: report.id });
    expect(contentOf<{ supersedes: string }>(correction).supersedes).toBe(report.id);
    expect(w.ports.selfReports.reports).toHaveLength(2);
    // Another scope cannot supersede (or learn of) Robin's report, and a worker cannot speak for the companion.
    expect(errorOf(await w.call(sam, 'emotion', 'self_report', { text: 'x', supersedes: report.id }))).toMatchObject({ kind: 'not_found' });
    const worker = workerOf(robin, [{ tool: 'concern', action: 'list' }]);
    expect(errorOf(await w.call(worker, 'emotion', 'self_report', { text: 'I am happy' }))).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });
    expect(errorOf(await w.emotion.selfReport(worker, { text: 'I am happy', supersedes: null }))).toMatchObject({ reason: 'worker_not_permitted' });
  });

  it('shows appraisals only to admitted audiences that may read their source', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    await w.talk(robin, 'hello', 'hi', 'k1', steady());
    await w.talk(robin, 'terrible news', 'I am here', 'k2', reading(-0.9, 0.4, 0));
    expect(contentOf<AppraisalEntry[]>(await w.call(robin, 'emotion', 'appraisals'))).toHaveLength(1);
    const freeTime = await w.admit('free-time');
    expect(contentOf<AppraisalEntry[]>(await w.call(freeTime, 'emotion', 'appraisals'))).toHaveLength(1);
    const sam = await w.admit('friend-dm');
    expect(errorOf(await w.call(sam, 'emotion', 'appraisals'))).toMatchObject({ kind: 'denied', reason: 'audience_not_admitted' });
    // A service caller that skips dispatch still gets nothing it may not read.
    expect(await w.emotion.appraisals(sam, { limit: 10 })).toEqual({ ok: true, value: [] });
  });
});

describe('concerns', () => {
  it('forms and resolves a concern with preserved evidence and relief applied once', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    const formed = await w.talk(robin, 'the move scares me', 'we will plan it together', 'k1', reading(-0.5, 0.4, -0.2));
    const created = contentOf<ActiveConcern>(
      await w.call(robin, 'concern', 'create', { text: 'Robin is anxious about the move', evidenceRefs: [{ kind: 'turn', ref: formed.turnId }] }),
    );
    expect(created).toMatchObject({ status: 'active', owner: 'companion', author: { kind: 'companion' }, sensitivity: 'confidential', revision: 1 });
    expect(created.formationVad?.valence).toBeCloseTo(-0.45, 6);
    expect(errorOf(await w.call(robin, 'concern', 'create', { text: 'Robin is anxious about the move!' }))).toMatchObject({ kind: 'conflict', reason: 'already_exists' });
    expect(errorOf(await w.call(robin, 'concern', 'create', { text: 'x', owner: 'operator' }))).toMatchObject({ kind: 'invalid' });

    const relieved = await w.talk(robin, 'the move went great', 'I am so happy for you', 'k2', reading(0.9, -0.3, 0.3));
    const resolved = contentOf<ConcernTransitionOutcome>(
      await w.call(robin, 'concern', 'resolve', { concernId: created.id, expectedRevision: 1, outcome: 'the move went well', evidenceRefs: [{ kind: 'turn', ref: relieved.turnId }] }),
    );
    expect(resolved.relief).toEqual({ status: 'applied' });
    const resolution = resolved.concern.resolution;
    expect(resolved.concern).toMatchObject({ status: 'resolved', revision: 2 });
    expect(resolved.concern.evidenceRefs.map((e) => e.ref)).toEqual([formed.turnId, relieved.turnId]);
    expect(resolution?.reliefDelta?.valence).toBeCloseTo(0.81, 6);
    expect(resolution?.arc).toMatchObject({ author: { kind: 'machine', producer: 'intention.concern_arc' }, text: expect.stringContaining('settled to') as unknown });
    const generationId = resolution?.generationId ?? '';
    expect(w.ports.emotionStates.observations.get(`relief:${generationId}`)).toMatchObject({ kind: 'concern_relief' });
    expect(await w.emotion.applyRelief(robin, { generationId, delta: { valence: 1, arousal: 0, dominance: 0 } })).toEqual({ ok: true, value: 'duplicate' });

    expect(errorOf(await w.call(robin, 'concern', 'transition', { concernId: created.id, to: 'active', expectedRevision: 1 }))).toMatchObject({ reason: 'stale_revision' });
    const sameEvidence = await w.call(robin, 'concern', 'transition', { concernId: created.id, to: 'active', expectedRevision: 2, evidenceRefs: [{ kind: 'turn', ref: relieved.turnId }] });
    expect(errorOf(sameEvidence)).toEqual({ kind: 'invalid', issues: ['reopening a resolved concern requires new evidence'] });
    expect(errorOf(await w.call(robin, 'concern', 'transition', { concernId: created.id, to: 'candidate', expectedRevision: 2 }))).toMatchObject({ kind: 'invalid' });
    const reopened = contentOf<ConcernTransitionOutcome>(
      await w.call(robin, 'concern', 'transition', { concernId: created.id, to: 'active', expectedRevision: 2, evidenceRefs: [{ kind: 'note', ref: 'boxes still unpacked' }] }),
    );
    expect(reopened.concern).toMatchObject({ status: 'active', resolution: null, revision: 3 });
    expect(reopened.concern.evidenceRefs).toHaveLength(3);
    const events = await w.ports.concerns.events(created.id, 10);
    expect(events.ok && events.value.map((e) => [e.kind, e.from, e.to])).toEqual([
      ['created', null, 'active'],
      ['transitioned', 'active', 'resolved'],
      ['transitioned', 'resolved', 'active'],
    ]);
    expect(events.ok && events.value[1]?.resolution?.generationId).toBe(generationId);
  });

  it('never fabricates affect: without a trusted estimate both snapshots stay empty and no relief is applied', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    const created = contentOf<ActiveConcern>(await w.call(robin, 'concern', 'create', { text: 'water the tomatoes', sensitivity: 'public' }));
    expect(created.formationVad).toBeNull();
    const resolved = contentOf<ConcernTransitionOutcome>(await w.call(robin, 'concern', 'resolve', { concernId: created.id, expectedRevision: 1 }));
    expect(resolved.relief).toEqual({ status: 'not_captured' });
    expect(resolved.concern.resolution).toMatchObject({ resolutionVad: null, reliefDelta: null, arc: null });
  });

  it("captures and relieves affect only inside the concern's own conversation", async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    const sam = await w.admit('friend-dm');
    await w.talk(sam, 'the exam is tomorrow', 'you prepared well', 'k1', steady());
    const samsConcern = contentOf<ActiveConcern>(await w.call(sam, 'concern', 'create', { text: 'Sam worries about the exam' }));
    expect(samsConcern.formationVad).toEqual({ valence: 0, arousal: 0, dominance: 0 });
    await w.talk(robin, 'awful day', 'I am here', 'k2', reading(-0.9, 0.8, -0.7));
    const robinBefore = await w.emotion.currentVad(robin);

    // Robin's primary DM may see and resolve Sam's concern, but must not stamp its own estimate onto it.
    const resolved = contentOf<ConcernTransitionOutcome>(await w.call(robin, 'concern', 'resolve', { concernId: samsConcern.id, expectedRevision: 1 }));
    expect(resolved.relief).toEqual({ status: 'not_captured' });
    expect(resolved.concern.resolution).toMatchObject({ resolutionVad: null, reliefDelta: null });
    expect(resolved.concern.resolution?.arc?.text ?? '').not.toMatch(/heavy|settled to/);
    expect(await w.emotion.currentVad(robin)).toEqual(robinBefore);
    expect([...w.ports.emotionStates.observations.keys()].filter((id) => id.startsWith('relief:'))).toEqual([]);

    const seenBySam = contentOf<ActiveConcern[]>(await w.call(sam, 'concern', 'list', { includeClosed: true }));
    expect(seenBySam.map((c) => c.resolution?.resolutionVad ?? null)).toEqual([null]);
    expect(JSON.stringify(seenBySam)).not.toMatch(/-0\.8|-0\.7|-0\.6/);
  });

  it('hides concerns an audience cannot read, without counting them', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    const sam = await w.admit('friend-dm');
    const robins = contentOf<ActiveConcern>(await w.call(robin, 'concern', 'create', { text: 'Robin has a hospital appointment' }));
    expect(contentOf<ActiveConcern[]>(await w.call(sam, 'concern', 'list', { includeClosed: true }))).toEqual([]);
    expect(errorOf(await w.call(sam, 'concern', 'resolve', { concernId: robins.id, expectedRevision: 1 }))).toEqual({ kind: 'not_found', subject: `concern ${robins.id}` });
    // The duplicate check only sees visible concerns, so it cannot be used to probe for hidden ones.
    const samsCopy = contentOf<ActiveConcern>(await w.call(sam, 'concern', 'create', { text: 'Robin has a hospital appointment' }));
    expect(samsCopy.sensitivity).toBe('personal');
    expect(errorOf(await w.call(sam, 'concern', 'create', { text: 'secret', sensitivity: 'intimate' }))).toMatchObject({ kind: 'invalid' });
    expect(
      errorOf(await w.call(sam, 'concern', 'create', { text: 'other', evidenceRefs: [{ kind: 'memory', ref: 'm-1', sensitivity: 'confidential' }] })),
    ).toMatchObject({ kind: 'invalid', issues: [expect.stringContaining('not admitted here') as unknown] });

    expect(contentOf<ActiveConcern[]>(await w.call(robin, 'concern', 'list')).map((c) => c.id).sort()).toEqual([robins.id, samsCopy.id].sort());
    const freeTime = await w.admit('free-time');
    expect(contentOf<ActiveConcern[]>(await w.call(freeTime, 'concern', 'list'))).toHaveLength(2);
    // A worker stays under its grant ceiling, even in Sam's own conversation.
    const worker = workerOf(sam, [{ tool: 'concern', action: 'list' }], 'personal');
    expect(contentOf<ActiveConcern[]>(await w.call(worker, 'concern', 'list'))).toEqual([]);
  });
});

describe('follow-ups', () => {
  it('creates idempotently into readable conversations only and activates in the target conversation', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    const sam = await w.admit('friend-dm');
    await w.converse(sam, 'hike on saturday?', 'gladly', 'k1');
    const dueAt = '2030-01-02T09:00:00.000Z';
    const first = contentOf<{ followUp: PendingFollowUp; created: boolean }>(
      await w.call(robin, 'concern', 'follow_up_create', { content: 'Ask how the move went', dueAt }),
    );
    expect(first).toMatchObject({ created: true, followUp: { state: 'pending', target: robin.audience, author: { kind: 'companion' } } });
    const retry = contentOf<{ followUp: PendingFollowUp; created: boolean }>(
      await w.call(robin, 'concern', 'follow_up_create', { content: '  Ask how the   move went ', dueAt: '2030-01-02T09:00:00Z' }),
    );
    expect(retry).toEqual({ followUp: first.followUp, created: false });

    const freeTime = await w.admit('free-time');
    expect(errorOf(await w.call(freeTime, 'concern', 'follow_up_create', { content: 'x', dueAt }))).toMatchObject({ kind: 'invalid' });
    const hike = contentOf<{ followUp: PendingFollowUp }>(
      await w.call(freeTime, 'concern', 'follow_up_create', { content: 'Check how the hike went', dueAt, channelId: 'dm-friend' }),
    ).followUp;
    expect(hike.target).toEqual(sam.audience);
    expect(errorOf(await w.call(freeTime, 'concern', 'follow_up_create', { content: 'x', dueAt, channelId: 'dm-nowhere' }))).toMatchObject({ kind: 'not_found' });
    const ash = await w.admit('stranger-dm');
    expect(errorOf(await w.call(ash, 'concern', 'follow_up_create', { content: 'x', dueAt, channelId: 'dm-friend' }))).toMatchObject({ kind: 'not_found' });
    expect(errorOf(await w.call(robin, 'concern', 'follow_up_create', { content: 'x', dueAt, concernId: 'concern-404' }))).toMatchObject({ kind: 'not_found' });
    expect(errorOf(await w.call(robin, 'concern', 'follow_up_create', { content: 'x', dueAt: 'next tuesday' }))).toMatchObject({ kind: 'invalid' });

    expect(contentOf<PendingFollowUp[]>(await w.call(sam, 'concern', 'follow_up_list')).map((f) => f.id)).toEqual([hike.id]);
    expect(contentOf<PendingFollowUp[]>(await w.call(robin, 'concern', 'follow_up_list'))).toHaveLength(2);

    const samLater = await w.admit('friend-dm-background');
    expect(errorOf(await w.call(samLater, 'concern', 'follow_up_activate', { followUpId: hike.id, expectedRevision: 1 }))).toMatchObject({ reason: 'background_turn' });
    expect(errorOf(await w.call(sam, 'concern', 'follow_up_activate', { followUpId: first.followUp.id, expectedRevision: 1 }))).toMatchObject({ kind: 'not_found' });
    expect(errorOf(await w.call(robin, 'concern', 'follow_up_activate', { followUpId: hike.id, expectedRevision: 1 }))).toMatchObject({ kind: 'invalid' });
    const activated = contentOf<PendingFollowUp>(await w.call(sam, 'concern', 'follow_up_activate', { followUpId: hike.id, expectedRevision: 1 }));
    expect(activated).toMatchObject({ state: 'activated', revision: 2, activatedAt: w.clock.now().toISOString() });
    expect(errorOf(await w.call(sam, 'concern', 'follow_up_activate', { followUpId: hike.id, expectedRevision: 1 }))).toMatchObject({ reason: 'stale_revision' });
    expect(contentOf<PendingFollowUp[]>(await w.call(sam, 'concern', 'follow_up_list'))).toEqual([]);
  });
});

describe('lists page past any fixed window', () => {
  const MANY = 600;

  it('finds a due follow-up behind hundreds of earlier ones in any state', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    const now = w.clock.now().getTime();
    for (let i = 0; i < MANY; i += 1) {
      const dueAt = new Date(now - 86_400_000 - i * 1000).toISOString();
      const made = contentOf<{ followUp: PendingFollowUp }>(await w.call(robin, 'concern', 'follow_up_create', { content: `old ${String(i)}`, dueAt }));
      if (i % 2 === 0) await w.call(robin, 'concern', 'follow_up_activate', { followUpId: made.followUp.id, expectedRevision: 1 });
    }
    const fresh = contentOf<{ followUp: PendingFollowUp; created: boolean }>(
      await w.call(robin, 'concern', 'follow_up_create', { content: 'ask how the interview went', dueAt: new Date(now - 1000).toISOString() }),
    );
    expect(fresh.created).toBe(true);
    const due = await w.followUps.due(robin, { limit: MANY });
    expect(due.ok && due.value).toHaveLength(MANY / 2 + 1);
    expect(due.ok && due.value.at(-1)?.content).toBe('ask how the interview went');
    const pending = await w.followUps.list(robin, { includeDone: false, limit: MANY });
    expect(pending.ok && pending.value.map((f) => f.content)).toContain('ask how the interview went');
    expect(pending.ok && pending.value.every((f) => f.state === 'pending')).toBe(true);
    const all = await w.followUps.list(robin, { includeDone: true, limit: 2 * MANY });
    expect(all.ok && all.value).toHaveLength(MANY + 1);
  });

  it('keeps an old open concern listed, counted and blocking duplicates behind hundreds of newer ones', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    const sam = await w.admit('friend-dm');
    const samsConcern = contentOf<ActiveConcern>(await w.call(sam, 'concern', 'create', { text: 'Sam worries about the exam' }));
    const later = (i: number) => new Date(w.clock.now().getTime() + 1000 + i * 1000).toISOString();
    for (let i = 0; i < MANY; i += 1) {
      // Newer concerns Sam may not see (formed in Robin's DM), and newer closed ones Sam may see.
      const hidden: ActiveConcern = { ...samsConcern, id: `concern-hidden-${String(i)}`, text: `hidden ${String(i)}`, formedIn: robin.audience, contactId: null, sensitivity: 'confidential', updatedAt: later(i) };
      const closed: ActiveConcern = { ...samsConcern, id: `concern-closed-${String(i)}`, text: `closed ${String(i)}`, status: 'resolved', updatedAt: later(i) };
      w.ports.concerns.concerns.set(hidden.id, hidden);
      w.ports.concerns.concerns.set(closed.id, closed);
    }
    expect(contentOf<ActiveConcern[]>(await w.call(sam, 'concern', 'list')).map((c) => c.id)).toEqual([samsConcern.id]);
    expect(contentOf<ActiveConcern[]>(await w.call(sam, 'concern', 'list', { includeClosed: true, limit: 50 }))).toHaveLength(50);
    expect(errorOf(await w.call(sam, 'concern', 'create', { text: 'Sam worries about the exam!' }))).toMatchObject({ kind: 'conflict', reason: 'already_exists' });
    await w.talk(sam, 'exam tomorrow', 'you will do well', 'k1', steady());
    const state = w.ports.emotionStates.states.get(`direct:${w.people.friend}`);
    expect(state?.selfModel?.openConcernCount).toBe(1);
  });

  it('shows a readable appraisal behind hundreds of newer ones it may not read', async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    await w.talk(robin, 'hello', 'hi', 'k1', steady());
    const moved = await w.talk(robin, 'terrible news', 'I am here', 'k2', reading(-0.9, 0.4, 0));
    const robins = (moved.observed.appraisal as { entry: AppraisalEntry }).entry;
    for (let i = 0; i < MANY; i += 1) {
      w.ports.appraisals.entries.push({ ...robins, id: `appraisal:internal-${String(i)}`, scopeKey: 'self', source: { kind: 'self' } });
    }
    expect(await w.emotion.appraisals(robin, { limit: 5 })).toEqual({ ok: true, value: [robins] });
  });
});

describe('self-state context', () => {
  it('keeps inference, authored reflection and signals distinct, never as participant speech, and filtered by audience', async () => {
    const w = await selfStateWorld();
    w.authenticator.tokens.set('primary-room', {
      surface: PI,
      principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId: 'primary-handle' } },
      room: { kind: 'group', channelId: 'room-1' as never, room: 'small_group' },
      turnKind: 'foreground',
    });
    const robin = await w.admit('primary-dm');
    const sam = await w.admit('friend-dm');
    const freeTime = await w.admit('free-time');
    await w.talk(robin, 'hello', 'hi', 'k1', steady());
    await w.talk(robin, 'I got the job!', 'that is wonderful', 'k2', reading(0.9, 0.5, 0.3));
    await w.selfReport(robin, 'I am delighted for Robin');
    await w.call(robin, 'values', 'add_value', { value: 'honesty with care' });
    await w.call(robin, 'concern', 'create', { text: 'Robin starts the new job on monday' });
    await w.call(robin, 'concern', 'follow_up_create', { content: 'Ask about the first day', dueAt: '2029-12-31T00:00:00.000Z' });
    w.ports.reflections.reflections.push(
      { id: 'r-1', text: 'I want to be steadier when news is big.', author: { kind: 'companion' }, source: { kind: 'self' }, createdAt: '2030-01-01T00:00:00.000Z' },
      { id: 'r-2', text: 'Nightly digest: three conversations.', author: { kind: 'machine', producer: 'digest' }, source: { kind: 'self' }, createdAt: '2030-01-01T00:00:00.000Z' },
    );

    const forRobin = await w.context.build(robin, { limit: 10 });
    if (!forRobin.ok) throw new Error(JSON.stringify(forRobin.error));
    expect(forRobin.value.every((e) => e.role === 'labelled_context' && e.label !== null)).toBe(true);
    const kinds = forRobin.value.map((e) => [e.origin.kind, e.text.slice(0, 24)]);
    expect(kinds).toEqual([
      ['machine_inference', 'Affect estimate for this'],
      ['machine_inference', 'Self-model signals: cert'],
      ['authored_reflection', 'What I last said about m'],
      ['machine_inference', 'machine summary (estimat'],
      ['internal_signal', 'Open concerns:\n- Robin s'],
      ['internal_signal', 'Follow-ups due here:\n- A'],
      ['authored_reflection', 'Value I hold: honesty wi'],
    ]);

    // Self-sourced reflections stay with companion-internal turns, and a machine log is not authored reflection.
    const internal = await w.context.build(freeTime, { limit: 10 });
    const reflections = internal.ok ? internal.value.filter((e) => e.text.includes('steadier') || e.text.includes('digest')) : [];
    expect(reflections.map((e) => e.origin)).toEqual([{ kind: 'machine_inference', producer: 'digest' }, { kind: 'authored_reflection' }]);

    const forSam = await w.context.build(sam, { limit: 10 });
    const samText = forSam.ok ? forSam.value.map((e) => e.text).join('\n') : 'failed';
    expect(samText).not.toMatch(/job|delighted|first day|steadier/);
    expect(samText).toContain('honesty with care');
    const inRoom = await w.context.build(await w.admit('primary-room'), { limit: 10 });
    expect(inRoom.ok && inRoom.value.map((e) => e.text).join('\n')).not.toMatch(/job|delighted|first day/);
  });
  it("gives a worker only what its grant would let it read through dispatch", async () => {
    const w = await selfStateWorld();
    const robin = await w.admit('primary-dm');
    const freeTime = await w.admit('free-time');
    await w.talk(robin, 'hello', 'hi', 'k1', steady());
    await w.talk(robin, 'I got the job!', 'that is wonderful', 'k2', reading(0.9, 0.5, 0.3));
    await w.selfReport(robin, 'I am delighted for Robin');
    await w.call(robin, 'values', 'add_value', { value: 'honesty with care' });
    await w.call(robin, 'concern', 'create', { text: 'bring the spare umbrella back', sensitivity: 'public' });
    w.ports.reflections.reflections.push({
      id: 'r-1',
      text: 'I want to be steadier when news is big.',
      author: { kind: 'companion' },
      source: { kind: 'self' },
      createdAt: '2030-01-01T00:00:00.000Z',
    });

    const narrow = workerOf(robin, [{ tool: 'memory', action: 'search' }], 'public');
    expect(errorOf(await w.call(narrow, 'emotion', 'read'))).toMatchObject({ reason: 'worker_not_permitted' });
    expect(errorOf(await w.emotion.read(narrow))).toMatchObject({ reason: 'worker_not_permitted' });
    expect(errorOf(await w.emotion.appraisals(narrow, { limit: 5 }))).toMatchObject({ reason: 'worker_not_permitted' });
    expect(await w.context.build(narrow, { limit: 10 })).toEqual({ ok: true, value: [] });

    // A grant for concern.list shows the concerns it could list, and still no affect, self-report or value.
    // A direct conversation discloses at confidential, so the worker needs that ceiling to see its concerns at all.
    const concernWorker = workerOf(robin, [{ tool: 'concern', action: 'list' }], 'confidential');
    expect(contentOf<ActiveConcern[]>(await w.call(concernWorker, 'concern', 'list')).map((c) => c.text)).toEqual(['bring the spare umbrella back']);
    const forWorker = await w.context.build(concernWorker, { limit: 10 });
    expect(forWorker.ok && forWorker.value.map((e) => e.text)).toEqual(['Open concerns:\n- bring the spare umbrella back (medium, active)']);

    // journal.reflections_list is closed to workers even under a confidential ceiling in a companion-internal turn.
    const internalWorker = workerOf(freeTime, [{ tool: 'memory', action: 'search' }], 'confidential');
    const internal = await w.context.build(internalWorker, { limit: 10 });
    expect(internal.ok && internal.value.map((e) => e.text).join('\n')).not.toMatch(/steadier|delighted|Affect estimate/);
  });
});

describe('self-state tools are wired into dispatch', () => {
  it('has a handler for every emotion and concern action except the unconfigured reminder store', async () => {
    const w = await selfStateWorld();
    const scope = await w.admit('primary-dm');
    for (const tool of TOOL_INVENTORY.filter((t) => t.name === 'emotion' || t.name === 'concern')) {
      for (const action of tool.actions) {
        const result = await w.call(scope, tool.name, action.name, {});
        const kind = result.ok ? 'ok' : result.error.kind;
        if (action.name === 'reminder_create') expect(kind).toBe('unavailable');
        else expect(kind, `${tool.name}.${action.name}`).not.toBe('unavailable');
      }
    }
    expect(errorOf(await w.call(scope, 'emotion', 'appraisals', { limit: 5, everything: true }))).toEqual({ kind: 'invalid', issues: ['unknown arguments: everything'] });
  });
});
