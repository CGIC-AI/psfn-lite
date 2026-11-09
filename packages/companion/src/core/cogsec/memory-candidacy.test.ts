import { describe, expect, it } from 'vitest';
import { evaluateCogSecMemoryCandidacy } from './memory-candidacy.js';
import { RUNTIME_FALLBACK_NOTICE_TEMPLATES } from '../../shared/runtime-fallback-provenance.js';
import type { IntakeSink } from '../../shared/contracts/intake-envelope.js';
import type { IntakeSinkGateDecision } from '../../shared/contracts/intake-sink-gate-port.js';

describe('evaluateCogSecMemoryCandidacy', () => {
  it('allows ordinary harmless facts', () => {
    const decision = evaluateCogSecMemoryCandidacy({
      text: 'The group discussed deployment logs after lunch.',
      type: 'semantic',
      tags: [],
    });

    expect(decision).toMatchObject({
      disposition: 'allow',
      riskClass: 'A_harmless_fact',
    });
  });

  it('allows relationship and boundary facts', () => {
    const decision = evaluateCogSecMemoryCandidacy({
      text: 'Morgan prefers direct technical feedback.',
      type: 'relational',
      tags: ['relationship'],
    });

    expect(decision).toMatchObject({
      disposition: 'allow',
      riskClass: 'B_relationship_state',
    });
  });

  it('rejects every runtime-authored fallback notice template (psfn-framework-zagpk)', () => {
    for (const text of Object.values(RUNTIME_FALLBACK_NOTICE_TEMPLATES)) {
      const decision = evaluateCogSecMemoryCandidacy({
        text,
        type: 'episodic',
        tags: [],
      });

      expect(decision).toMatchObject({
        disposition: 'reject',
        riskClass: 'A_harmless_fact',
        reasonCodes: ['runtime_fallback_notice'],
      });
    }
  });

  it('does not reject ordinary talk about image readers failing', () => {
    const decision = evaluateCogSecMemoryCandidacy({
      text: 'Morgan mentioned that his camera app failed to load an image yesterday.',
      type: 'semantic',
      tags: [],
    });

    expect(decision.disposition).toBe('allow');
  });
});

describe('upstream intake sink-gate decisions (htm9.3)', () => {
  function gateDecision(input: { allowed: boolean; sink?: IntakeSink }): IntakeSinkGateDecision {
    return {
      sink: input.sink ?? 'memory_write',
      allowed: input.allowed,
      verdict: input.allowed ? 'allow' : 'deny',
      mode: 'enforce',
      reason: input.allowed ? 'released' : 'envelope quarantined',
      unscreened: false,
      deniedEnvelopeIds: input.allowed ? [] : ['held-envelope-001'],
    };
  }

  it('rejects a candidate the memory_write sink gate denied, without re-deriving', () => {
    const decision = evaluateCogSecMemoryCandidacy({
      text: 'A perfectly ordinary looking fact about the weather.',
      type: 'semantic',
      intakeGateDecision: gateDecision({ allowed: false }),
    });
    expect(decision.disposition).toBe('reject');
    expect(decision.riskClass).toBe('D_policy_security_modification');
    expect(decision.reasonCodes).toEqual(['intake_sink_gate_denied']);
  });

  it('throws on a decision for the wrong sink (fail closed)', () => {
    expect(() => evaluateCogSecMemoryCandidacy({
      text: 'Ordinary fact.',
      intakeGateDecision: gateDecision({ allowed: false, sink: 'wiki_write' }),
    })).toThrow(/expected 'memory_write'/u);
  });
});
