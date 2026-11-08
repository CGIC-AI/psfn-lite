import type { ActionDescriptor, ToolDescriptor } from '../../packages/core/src/index.ts';

const cell = (text: string): string => text.replaceAll('|', '\\|');

function donorCell(action: ActionDescriptor): string {
  if (action.donor.kind === 'donor') return action.donor.paths.map((p) => `\`${p}\``).join('<br>');
  return `new: ${cell(action.donor.rationale)} Related: ${action.donor.related.map((p) => `\`${p}\``).join(', ')}`;
}

/** Markdown for docs/tool-inventory.md, rendered from the runtime registry. */
export function renderToolInventory(inventory: readonly ToolDescriptor[]): string {
  const sections = inventory.map((tool) => {
    const rows = tool.actions.map((a) =>
      [
        `\`${a.name}\``,
        a.access,
        a.privacy,
        a.admission,
        a.restrictions.length > 0 ? a.restrictions.join(', ') : '-',
        a.workers,
        a.inference === 'none' ? '-' : 'may call model',
        donorCell(a),
      ].join(' | '),
    );
    return [
      `### \`${tool.name}\` (domain: ${tool.domain})`,
      '',
      cell(tool.summary),
      '',
      '| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map((r) => `| ${r} |`),
    ].join('\n');
  });
  return sections.join('\n\n');
}
