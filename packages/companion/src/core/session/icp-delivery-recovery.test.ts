import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  parseIcpDeliveryObservation,
  parseIcpRecoveryResponse,
  serializeIcpDeliveryObservation,
} from './icp-delivery-recovery.js';
import { ICP_RECOVERY_METADATA_KEY_HANDLING } from './icp-recovery-response-metadata.js';
import {
  buildInternalStateSnapshotRef,
  InternalStateComputer,
  serializeInternalState,
} from '../self-model/state.js';
import { createEmptyToolCallOutcomeCounts } from '../../shared/contracts/tool-call-outcome.js';
import {
  CHANNEL,
  PEER,
  SOURCE,
  chargedCorrelation,
  correlation,
  recoveryResponse,
} from './icp-recovery.test-fixtures.js';

function suppressedRecovery(overrides: Record<string, unknown> = {}) {
  return {
    ...recoveryResponse,
    content: '',
    metadata: {
      ...recoveryResponse.metadata,
      icpCorrelation: { ...correlation, fatigueDecision: 'suppress' },
    },
    ...overrides,
  };
}

describe('ICP delivery recovery codec', () => {
  it('round-trips the strict completed-delivery shape', () => {
    const content = serializeIcpDeliveryObservation({
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
      status: 'delivered',
      gatewayMessageId: 'companion-reply-stable',
      deliveredTo: [PEER],
      recoveryResponse,
      turnCompleted: true,
    });

    expect(parseIcpDeliveryObservation(content, {
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
    })).toEqual({
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
      status: 'delivered',
      gatewayMessageId: 'companion-reply-stable',
      deliveredTo: [PEER],
      recoveryResponse,
      turnCompleted: true,
    });
  });

  it('rejects unknown observation fields instead of casting through them', () => {
    const content = JSON.stringify({
      schemaVersion: 1,
      kind: 'icp_delivery',
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
      status: 'failed',
      error: 'transport failed',
      legacyFallback: true,
    });

    expect(() => parseIcpDeliveryObservation(content, {
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
    })).toThrow(/unknown fields/i);
  });

  it('rejects recovery response lineage with a different stable turn', () => {
    const mismatched = {
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082',
      },
    };

    expect(() => parseIcpRecoveryResponse(mismatched, {
      label: 'test recovery response',
      expectedChannelId: CHANNEL,
      expectedSourceMessageId: SOURCE,
    })).toThrow(/lineage/i);
  });


  it('rejects non-finite recovery usage accounting', () => {
    const malformed = {
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        outputTokens: Number.POSITIVE_INFINITY,
      },
    };

    expect(() => parseIcpRecoveryResponse(malformed, {
      label: 'test recovery response',
    })).toThrow(/non-negative finite/i);
  });

  it.each([
    ['noReply', {}],
    ['internalState', {}],
    ['internalStateSnapshotRef', 42],
    ['metacognitiveFlags', {}],
    ['retrievalProvenanceRefs', {}],
    ['diagnostics', []],
    ['broadcastSafety', []],
  ])('rejects a malformed permitted metadata field %s', (field, malformedValue) => {
    const malformed = {
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        [field]: malformedValue,
      },
    };

    expect(() => parseIcpRecoveryResponse(malformed, {
      label: 'test recovery response',
    })).toThrow(new RegExp(`metadata\\.${field}`, 'i'));
  });

  it('round-trips the content-free tool-call census an intentional no-reply turn records', () => {
    const census = {
      ...createEmptyToolCallOutcomeCounts(),
      success: 1,
      content_withheld: 2,
    };
    const withCensus = {
      ...recoveryResponse,
      content: '',
      metadata: {
        ...recoveryResponse.metadata,
        toolCallOutcomes: census,
        noReply: {
          schemaVersion: 1,
          disposition: 'intentional_no_reply',
          source: 'response_control_tool',
          auditId: 'no-reply-census',
          decidedAt: 1_700_000_000_000,
          turnId: correlation.turnId,
          requestId: correlation.requestId,
          channelId: CHANNEL,
        },
      },
    };

    expect(parseIcpRecoveryResponse(withCensus, {
      label: 'test recovery response',
      expectedChannelId: CHANNEL,
      expectedSourceMessageId: SOURCE,
    })).toEqual(withCensus);
  });

  it.each([
    ['an unknown outcome', {
      ...createEmptyToolCallOutcomeCounts(),
      quarantined: 1,
    }, /toolCallOutcomes contains unknown fields: quarantined/i],
    ['a missing outcome', (() => {
      const { partial_result: _dropped, ...rest } = createEmptyToolCallOutcomeCounts();
      return rest;
    })(), /toolCallOutcomes\.partial_result must be a non-negative finite number/i],
    ['a negative count', {
      ...createEmptyToolCallOutcomeCounts(),
      policy_denial: -1,
    }, /toolCallOutcomes\.policy_denial must be a non-negative finite number/i],
    ['a fractional count', {
      ...createEmptyToolCallOutcomeCounts(),
      success: 1.5,
    }, /toolCallOutcomes\.success must be a whole count/i],
  ])('rejects a recorded tool-call census with %s', (_label, toolCallOutcomes, expected) => {
    const malformed = {
      ...recoveryResponse,
      metadata: { ...recoveryResponse.metadata, toolCallOutcomes },
    };

    expect(() => parseIcpRecoveryResponse(malformed, {
      label: 'test recovery response',
    })).toThrow(expected);
  });

  it.each([
    ['visible content', { content: 'forged deliverable text' }],
    ['an attachment', {
      attachments: [{
        url: 'https://example.invalid/forged.png',
        contentType: 'image/png',
        name: 'forged.png',
      }],
    }],
  ])('rejects a fatigue-suppressed recovery response with %s', (_label, overrides) => {
    expect(() => parseIcpRecoveryResponse(suppressedRecovery(overrides), {
      label: 'test suppressed recovery response',
    })).toThrow(/suppressed.*deliverable/i);
  });

  it.each([
    ['suppressed status with an allowed response', 'suppressed', {
      ...recoveryResponse,
      metadata: { ...recoveryResponse.metadata, icpCorrelation: chargedCorrelation },
    }],
    ['prepared status with a suppressed response', 'prepared', suppressedRecovery()],
  ])('rejects %s', (_label, status, response) => {
    const observation = JSON.stringify({
      schemaVersion: 1,
      kind: 'icp_delivery',
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
      status,
      recoveryResponse: response,
    });

    expect(() => parseIcpDeliveryObservation(observation, {
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
    })).toThrow(/suppressed.*deliverable|status.*fatigue decision/i);
  });

  it.each([
    ['delivered without recovery evidence', {
      status: 'delivered',
      gatewayMessageId: 'companion-reply-stable',
    }],
    ['failed without recovery evidence', {
      status: 'failed',
      error: 'transport failed',
    }],
    ['delivered with whitespace-only transport content', {
      status: 'delivered',
      gatewayMessageId: 'companion-reply-stable',
      recoveryResponse: { ...recoveryResponse, content: ' \n\t ' },
    }],
    ['failed with whitespace-only transport content', {
      status: 'failed',
      error: 'transport failed',
      recoveryResponse: { ...recoveryResponse, content: ' \n\t ' },
    }],
  ])('rejects %s', (_label, fields) => {
    const observation = JSON.stringify({
      schemaVersion: 1,
      kind: 'icp_delivery',
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
      ...fields,
    });

    expect(() => parseIcpDeliveryObservation(observation, {
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
    })).toThrow(/missing recovery response|transport content/i);
  });

  it('requires internal state and snapshot reference as a verified pair', () => {
    const state = new InternalStateComputer().computeState({
      activeConcerns: [],
      trustLevel: 'regular',
      sessionMetrics: {
        userMessageText: 'hello',
        responseText: 'hi',
        toolCallCount: 0,
        recentTurnCount: 1,
      },
    });
    const snapshotRef = buildInternalStateSnapshotRef(state);
    const valid = {
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        internalState: state,
        internalStateSnapshotRef: snapshotRef,
      },
    };

    expect(parseIcpRecoveryResponse(valid, { label: 'test recovery response' })).toEqual(valid);
    expect(() => parseIcpRecoveryResponse({
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        internalStateSnapshotRef: snapshotRef,
      },
    }, { label: 'test recovery response' })).toThrow(/internal state.*pair/i);
    expect(() => parseIcpRecoveryResponse({
      ...valid,
      metadata: {
        ...valid.metadata,
        internalStateSnapshotRef: 'internal-state-v1:not-the-state',
      },
    }, { label: 'test recovery response' })).toThrow(/snapshot reference.*match/i);
  });

  it('accepts a snapshot reference recorded before emotional.discrepancies existed', () => {
    const state = new InternalStateComputer().computeState({
      activeConcerns: [],
      trustLevel: 'regular',
      sessionMetrics: {
        userMessageText: 'hello',
        responseText: 'hi',
        toolCallCount: 0,
        recentTurnCount: 1,
      },
    });
    // Pre-discrepancies images hashed the serialization without that key.
    const legacyShape = JSON.parse(serializeInternalState(state)) as { emotional: Record<string, unknown> };
    delete legacyShape.emotional.discrepancies;
    const legacyRef = `internal-state-v1:${createHash('sha256').update(JSON.stringify(legacyShape)).digest('hex').slice(0, 16)}`;
    expect(legacyRef).not.toEqual(buildInternalStateSnapshotRef(state));

    const recorded = {
      ...recoveryResponse,
      metadata: {
        ...recoveryResponse.metadata,
        internalState: state,
        internalStateSnapshotRef: legacyRef,
      },
    };
    expect(parseIcpRecoveryResponse(recorded, { label: 'test recovery response' })).toEqual(recorded);

    // The legacy path never excuses a genuinely wrong ref.
    expect(() => parseIcpRecoveryResponse({
      ...recorded,
      metadata: {
        ...recorded.metadata,
        internalStateSnapshotRef: 'internal-state-v1:0123456789abcdef',
      },
    }, { label: 'test recovery response' })).toThrow(/snapshot reference.*match/i);

    // A state carrying real discrepancies must match the modern ref exactly.
    const withDiscrepancy = {
      ...state,
      emotional: {
        ...state.emotional,
        discrepancies: [...state.emotional.discrepancies, {
          kind: 'valence_vs_discrete',
          magnitude: 0.5,
          sides: [
            { family: 'vad_valence', label: 'vad', value: -0.2, confidence: 0.9, provenance: [{ source: 'runtime_state' }] },
            { family: 'discrete_affect', label: 'calm', value: 0.6, confidence: 0.8, provenance: [{ source: 'classifier_inferred' }] },
          ],
        }],
      },
    } as typeof state;
    expect(() => parseIcpRecoveryResponse({
      ...recorded,
      metadata: {
        ...recorded.metadata,
        internalState: withDiscrepancy,
        internalStateSnapshotRef: legacyRef,
      },
    }, { label: 'test recovery response' })).toThrow(/snapshot reference.*match/i);
  });
});

describe('ICP delivery recovery metadata contract', () => {
  const noReply = {
    schemaVersion: 1,
    disposition: 'intentional_no_reply',
    source: 'response_control_tool',
    auditId: 'no-reply-runtime-fallback',
    decidedAt: 1_700_000_000_000,
    turnId: correlation.turnId,
    requestId: correlation.requestId,
    channelId: CHANNEL,
  } as const;

  const runtimeFallbackProvenance = {
    schemaVersion: 1,
    authoredBy: 'runtime',
    model: 'runtime-fallback',
    strategy: 'runtime_nonfabricating_notice',
  } as const;

  const notificationAck = {
    schemaVersion: 1,
    disposition: 'notification_ack',
    outcome: 'forwarded_to_agent',
  } as const;

  function suppressedObservationWith(metadata: Record<string, unknown>) {
    return {
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
      status: 'suppressed' as const,
      recoveryResponse: {
        ...recoveryResponse,
        content: '',
        metadata: { ...recoveryResponse.metadata, noReply, ...metadata },
      },
      turnCompleted: true as const,
    };
  }

  // psfn-framework-lvoda: a correlated no-reply turn that also took a runtime
  // fallback (or acknowledged an async notification) carries both fields on the
  // SAME ResponseMetadata the durable observation records. Before the codec
  // admitted them, serializing that observation threw "unknown fields" and the
  // companion turn failed instead of recording the silence.
  it('round-trips runtime fallback provenance and a notification ack on a no-reply turn', () => {
    const observation = suppressedObservationWith({
      runtimeFallbackProvenance,
      notificationAck,
    });

    const content = serializeIcpDeliveryObservation(observation);

    expect(parseIcpDeliveryObservation(content, {
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
    })).toEqual(observation);
  });

  it.each([
    ['a legacy runtime fallback strategy', {
      runtimeFallbackProvenance: {
        ...runtimeFallbackProvenance,
        strategy: 'runtime_datetime_contradiction_refusal',
      },
    }],
    ['a policy-blocked notification ack', {
      notificationAck: { ...notificationAck, outcome: 'blocked_by_policy' },
    }],
  ])('recovers %s', (_label, metadata) => {
    const observation = suppressedObservationWith(metadata);

    expect(parseIcpDeliveryObservation(serializeIcpDeliveryObservation(observation), {
      channelId: CHANNEL,
      sourceMessageId: SOURCE,
    })).toEqual(observation);
  });

  it.each([
    ['an unknown runtime fallback strategy', {
      runtimeFallbackProvenance: { ...runtimeFallbackProvenance, strategy: 'invented_strategy' },
    }, /runtimeFallbackProvenance\.strategy is invalid/i],
    ['a non-runtime fallback author', {
      runtimeFallbackProvenance: { ...runtimeFallbackProvenance, authoredBy: 'companion' },
    }, /runtimeFallbackProvenance\.authoredBy must be "runtime"/i],
    ['a fallback provenance carrying an extra field', {
      runtimeFallbackProvenance: { ...runtimeFallbackProvenance, note: 'extra' },
    }, /runtimeFallbackProvenance contains unknown fields: note/i],
    ['an unknown notification ack outcome', {
      notificationAck: { ...notificationAck, outcome: 'dropped' },
    }, /notificationAck\.outcome is unsupported/i],
    ['a mismatched notification ack disposition', {
      notificationAck: { ...notificationAck, disposition: 'intentional_no_reply' },
    }, /notificationAck\.disposition is unsupported/i],
    ['a notification ack carrying an extra field', {
      notificationAck: { ...notificationAck, channelId: CHANNEL },
    }, /notificationAck contains unknown fields: channelId/i],
  ])('rejects %s', (_label, metadata, expected) => {
    expect(() => parseIcpRecoveryResponse({
      ...recoveryResponse,
      content: '',
      metadata: { ...recoveryResponse.metadata, noReply, ...metadata },
    }, { label: 'test recovery response' })).toThrow(expected);
  });

  // The allowlist is a strict, fail-closed key set: a ResponseMetadata field the
  // turn runtime writes but this codec has never heard of aborts an ICP no-reply
  // turn at serialize time. Enumerate the contract's own members so the next
  // addition is caught here (and by the `satisfies` on the handling map) instead
  // of in production.
  it('accounts for every ResponseMetadata field declared by the runtime contract', () => {
    const contractPath = new URL('../../shared/contracts/runtime-base.ts', import.meta.url);
    const source = ts.createSourceFile(
      'runtime-base.ts',
      readFileSync(contractPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration => (
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'ResponseMetadata'
      ),
    );
    if (!declaration) throw new Error('ResponseMetadata interface was not found');
    const contractKeys = declaration.members.map(member => {
      if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name)) {
        throw new Error('ResponseMetadata carries a member this contract test cannot enumerate');
      }
      return member.name.text;
    });

    expect(contractKeys.length).toBeGreaterThan(0);
    expect([...contractKeys].sort()).toEqual(
      Object.keys(ICP_RECOVERY_METADATA_KEY_HANDLING).sort(),
    );
    expect(Object.values(ICP_RECOVERY_METADATA_KEY_HANDLING))
      .not.toContain(undefined);
  });

  it('still rejects a metadata field outside the allowlist', () => {
    expect(() => parseIcpRecoveryResponse({
      ...recoveryResponse,
      metadata: { ...recoveryResponse.metadata, unhandledFutureField: 1 },
    }, { label: 'test recovery response' }))
      .toThrow(/contains unknown fields: unhandledFutureField/i);
  });
});
