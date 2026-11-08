import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AttributedToolResult, CoreError } from './core.ts';

/**
 * What a client sees of a core failure. Denials, conflicts, invalid input and
 * misses keep core's own wording, which never names another audience's
 * content. An `unavailable` detail can carry storage or driver text, so it is
 * replaced; the operator sees the original through `onError`.
 */
export function publicError(error: CoreError): Readonly<Record<string, unknown>> {
  switch (error.kind) {
    case 'denied':
      return { kind: 'denied', reason: error.reason, detail: error.detail };
    case 'not_found':
      return { kind: 'not_found', subject: error.subject };
    case 'conflict':
      return {
        kind: 'conflict',
        reason: error.reason,
        detail: error.detail,
        ...(error.expectedRevision === undefined ? {} : { expectedRevision: error.expectedRevision }),
        ...(error.actualRevision === undefined ? {} : { actualRevision: error.actualRevision }),
      };
    case 'invalid':
      return { kind: 'invalid', issues: error.issues };
    case 'unavailable':
      return { kind: 'unavailable', capability: error.capability, detail: 'the capability is unavailable; try again later' };
  }
}

function render(payload: Readonly<Record<string, unknown>>, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: { ...payload }, ...(isError ? { isError: true } : {}) };
}

/** A tool result, labelled as tool output so a harness never renders it as speech. */
export function successResult(result: AttributedToolResult): CallToolResult {
  return render({ origin: result.origin, content: result.content }, false);
}

export function errorResult(error: CoreError): CallToolResult {
  return render({ error: publicError(error) }, true);
}
