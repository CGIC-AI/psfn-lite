/**
 * The Garden's two transcript directives. The companion's reply can carry
 * `::garden-memory{id="<memory id>"}` for a memory card or
 * `::garden-layer-diff{layer="<prompt layer id>"}` for the last change to a
 * persona layer. Desktop renders the claimed name in place
 * (apps/desktop/src/lib/transcript-directives.ts). The attributes are model
 * output: each is checked before it becomes part of a path, and a bad one
 * renders as a short note.
 */
import { LAYER_ID, MEMORY_ID, path, type LayerDiff, type MemoryDetail, type Rest } from './api.ts';
import { lineDiff } from './diff.ts';
import { Card, Muted, Show, useLoad, when } from './ui.tsx';

export const MEMORY_DIRECTIVE = 'garden-memory';
export const LAYER_DIFF_DIRECTIVE = 'garden-layer-diff';

const lineStyle = {
  same: {},
  added: { background: 'var(--ui-diff-added, rgba(46,160,67,0.18))' },
  removed: { background: 'var(--ui-diff-removed, rgba(248,81,73,0.18))', textDecoration: 'line-through' },
} as const;
const mark = { same: ' ', added: '+', removed: '−' } as const;

export function MemoryDirective({ rest, attrs }: { rest: Rest; attrs: Readonly<Record<string, string>> }) {
  const id = attrs['id'] ?? '';
  const valid = MEMORY_ID.test(id);
  const detail = useLoad<MemoryDetail>(rest, valid ? path.memory(id) : null);
  if (!valid) return <Muted>(a memory card without a valid memory id)</Muted>;
  return (
    <Show loaded={detail}>
      {({ memory }) => (
        <Card label={`memory ${memory.id}`}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{memory.text}</div>
          <Muted>{memory.type} · {memory.sensitivity} · importance {memory.importance} · {when(memory.extractedAt)}</Muted>
        </Card>
      )}
    </Show>
  );
}

export function LayerDiffView({ rest, layerId }: { rest: Rest; layerId: string }) {
  const diff = useLoad<LayerDiff>(rest, path.layerDiff(layerId));
  // The route answers 404 with "Prompt layer not found or no previous version" for a layer never changed.
  if (diff.error !== null) return <Muted>No change to show: {diff.error}</Muted>;
  return (
    <Show loaded={diff}>
      {(d) => {
        const lines = lineDiff(d.oldContent, d.newContent);
        return (
          <pre aria-label={`layer ${layerId} change`} style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8rem', margin: '6px 0' }}>
            {lines.map((line, index) => (
              <div key={index} data-diff={line.kind} style={lineStyle[line.kind]}>{mark[line.kind]} {line.text}</div>
            ))}
          </pre>
        );
      }}
    </Show>
  );
}

export function LayerDiffDirective({ rest, attrs }: { rest: Rest; attrs: Readonly<Record<string, string>> }) {
  const layerId = attrs['layer'] ?? '';
  if (!LAYER_ID.test(layerId)) return <Muted>(a layer change without a valid layer id)</Muted>;
  return <LayerDiffView rest={rest} layerId={layerId} />;
}
