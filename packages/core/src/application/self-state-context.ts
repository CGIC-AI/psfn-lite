import { describeVad, type AuthoredReflectionPort } from '../emotion/index.ts';
import { canViewerRead, denied, ok, type Author, type InternalOrigin, type Result } from '../shared/index.ts';
import type { ConcernService } from './concern-service.ts';
import { internalContext, type ContextEntry } from './context.ts';
import type { EmotionService } from './emotion-service.ts';
import type { FollowUpService } from './follow-up-service.ts';
import { TOOL_INVENTORY, resolveAction } from './tool-inventory.ts';
import { isTrustedTurnScope, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';
import type { ValuesService } from './values-service.ts';

export interface SelfStateContext {
  /**
   * The companion's orientation beyond retrieved facts, as labelled internal
   * context for this turn: machine estimates and appraisals, companion
   * self-reports, authored values and reflections, open concerns and due
   * follow-ups. Each item passes the same admission and audience rules as the
   * tool that would show it, and none can render as participant speech.
   */
  build(scope: TrustedTurnScope, input: { readonly limit: number }): Promise<Result<readonly ContextEntry[]>>;
}

export function createSelfStateContext(deps: {
  readonly emotion: EmotionService;
  readonly concerns: ConcernService;
  readonly followUps: FollowUpService;
  readonly values: ValuesService;
  readonly reflections: AuthoredReflectionPort;
}): SelfStateContext {
  return {
    async build(scope, input) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      const pieces: { readonly origin: InternalOrigin; readonly text: string }[] = [];
      const push = (origin: InternalOrigin, text: string) => {
        pieces.push({ origin, text });
      };
      const admits = (tool: string, action: string) => {
        const resolved = resolveAction(TOOL_INVENTORY, tool, action);
        return resolved.ok && scope.admitted.includes(resolved.value.action.admission);
      };

      const reading = await deps.emotion.read(scope);
      if (!reading.ok && reading.error.kind !== 'not_found') return reading;
      if (reading.ok) {
        const { estimate, selfModel, latestSelfReport } = reading.value;
        push(
          { kind: 'machine_inference', producer: estimate.producer },
          `Affect estimate for this conversation (confidence ${estimate.confidence.toFixed(2)}): ${estimate.description}.`,
        );
        if (selfModel !== null) {
          push(
            { kind: 'machine_inference', producer: 'self_model' },
            `Self-model signals: certainty ${selfModel.certainty}, engagement ${selfModel.engagement}, processing ${selfModel.processing}, conversation ${selfModel.trajectory}.`,
          );
        }
        if (latestSelfReport !== null) push({ kind: 'authored_reflection' }, `What I last said about my own state here: ${latestSelfReport.text}`);
      }

      if (admits('emotion', 'appraisals')) {
        const appraisals = await deps.emotion.appraisals(scope, { limit: 1 });
        if (!appraisals.ok) return appraisals;
        for (const entry of appraisals.value) push({ kind: 'machine_inference', producer: 'emotion.appraisal' }, `${entry.summary} (estimated ${describeVad(entry.vad)})`);
      }

      if (admits('concern', 'list')) {
        const concerns = await deps.concerns.list(scope, { includeClosed: false, limit: input.limit });
        if (!concerns.ok) return concerns;
        if (concerns.value.length > 0) {
          push({ kind: 'internal_signal', source: 'concerns' }, `Open concerns:\n${concerns.value.map((c) => `- ${c.text} (${c.priority}, ${c.status})`).join('\n')}`);
        }
      }
      if (admits('concern', 'follow_up_list')) {
        const due = await deps.followUps.due(scope, { limit: input.limit });
        if (!due.ok) return due;
        if (due.value.length > 0) push({ kind: 'internal_signal', source: 'follow_ups' }, `Follow-ups due here:\n${due.value.map((f) => `- ${f.content}`).join('\n')}`);
      }

      if (admits('values', 'list_values')) {
        const values = await deps.values.listValues(scope, { limit: input.limit });
        if (!values.ok) return values;
        for (const value of values.value) push(originFor(value.author), `Value I hold: ${value.reflection}`);
      }
      if (admits('journal', 'reflections_list')) {
        const reflections = await deps.reflections.recent(input.limit);
        if (!reflections.ok) return reflections;
        const viewer = viewerOf(scope);
        for (const reflection of reflections.value.filter((r) => canViewerRead(viewer, r.source))) push(originFor(reflection.author), reflection.text);
      }
      const entries: ContextEntry[] = [];
      for (const piece of pieces) {
        const entry = internalContext(piece.origin, piece.text);
        if (!entry.ok) return entry;
        entries.push(entry.value);
      }
      return ok(entries);
    },
  };
}

/** Only the companion's own words are authored reflection; everything else keeps its real author. */
function originFor(author: Author): InternalOrigin {
  switch (author.kind) {
    case 'companion':
      return { kind: 'authored_reflection' };
    case 'machine':
      return { kind: 'machine_inference', producer: author.producer };
    case 'participant':
      return { kind: 'system_note', source: 'participant-authored record' };
    case 'operator':
      return { kind: 'system_note', source: `operator:${author.actor}` };
    case 'system':
      return { kind: 'system_note', source: author.source };
  }
}
