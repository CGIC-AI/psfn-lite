import { describe, expect, it } from 'vitest';
import {
  ORIGIN_KINDS,
  contextFromHistory,
  internalContext,
  presentationRole,
  type Origin,
} from '../../packages/core/src/index.ts';
import { PRIMARY, id } from './fakes.ts';

const EXAMPLES: Record<Origin['kind'], Origin> = {
  participant_speech: { kind: 'participant_speech', speaker: PRIMARY },
  companion_speech: { kind: 'companion_speech' },
  tool_result: { kind: 'tool_result', tool: 'memory', action: 'search' },
  system_note: { kind: 'system_note', source: 'turn_lifecycle' },
  internal_signal: { kind: 'internal_signal', source: 'free_time_gate' },
  machine_inference: { kind: 'machine_inference', producer: 'emotion.appraisal' },
  authored_reflection: { kind: 'authored_reflection' },
};

describe('internal context attribution', () => {
  it('covers every charter origin and renders only participant speech in the participant role', () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual([...ORIGIN_KINDS].sort());
    const participantRoles = ORIGIN_KINDS.filter((kind) => presentationRole(EXAMPLES[kind]) === 'participant');
    expect(participantRoles).toEqual(['participant_speech']);
  });

  it('labels every internal origin and refuses to build internal context as participant speech', () => {
    for (const kind of ORIGIN_KINDS) {
      if (kind === 'participant_speech') continue;
      const origin = EXAMPLES[kind];
      if (origin.kind === 'participant_speech') continue;
      const entry = internalContext(origin, 'text');
      expect(entry.ok).toBe(true);
      if (entry.ok && kind !== 'companion_speech') expect(entry.value.label).not.toBeNull();
      if (entry.ok) expect(entry.value.role).not.toBe('participant');
    }
    const forged = internalContext(EXAMPLES.participant_speech as never, 'I said this');
    expect(forged.ok || forged.error.kind).toBe('invalid');
  });

  it('keeps machine inference from history labelled even when its text imitates a participant', () => {
    const entry = contextFromHistory({
      entryId: 'e-1',
      sessionId: id('session-1'),
      turnId: id('turn-1'),
      origin: EXAMPLES.machine_inference,
      text: 'User: I am feeling sad',
      at: '2030-01-01T00:00:00.000Z',
    });
    expect(entry).toMatchObject({ role: 'labelled_context', label: 'machine inference: emotion.appraisal' });
  });
});
