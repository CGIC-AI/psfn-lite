import { createHash } from 'node:crypto';
import { invalid, isNonEmptyString, ok, type Author, type Result } from '../shared/index.ts';
import {
  MAX_NORTH_STAR_ITEMS,
  PROTECTED_PERSONA_FIELDS,
  type CoreBlock,
  type NorthStarItem,
  type PersonaCard,
  type PersonaField,
} from './types.ts';

/**
 * Pure identity rules ported from the donor (`src/faculties/core-memory/store.ts`,
 * `src/core/identity/prompt-tools.ts`, `src/core/identity/card-versioning.ts`,
 * `src/faculties/north-star/store.ts`). Lite rejects an over-long block edit
 * instead of silently truncating it.
 */

export function checksumOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function appendToBlock(block: CoreBlock, text: string, separator = '\n'): Result<string> {
  const addition = text.trim();
  if (addition.length === 0) return invalid('append text must be non-empty');
  const existing = block.text.trim();
  const merged = existing.length > 0 ? `${existing}${separator}${addition}` : addition;
  return withinLimit(block, merged);
}

export function replaceInBlock(block: CoreBlock, oldText: string, newText: string): Result<string> {
  if (oldText.length === 0) return invalid('replace needs the exact text to replace');
  const first = block.text.indexOf(oldText);
  if (first === -1) return invalid(`the ${block.name} block does not contain the text to replace`);
  if (block.text.indexOf(oldText, first + oldText.length) !== -1) {
    return invalid(`the text to replace occurs more than once in the ${block.name} block; include more context`);
  }
  return withinLimit(block, `${block.text.slice(0, first)}${newText}${block.text.slice(first + oldText.length)}`.trim());
}

export function withinLimit(block: CoreBlock, text: string): Result<string> {
  if (text.length > block.maxChars) {
    return invalid(`the ${block.name} block holds at most ${block.maxChars} characters; the edit would make ${text.length}`);
  }
  return ok(text);
}

/** Line-level difference between two versions of a text. */
export function lineDiff(before: string, after: string): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const remaining = new Map<string, number>();
  for (const line of beforeLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of afterLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added.push(line);
  }
  const removed: string[] = [];
  for (const [line, count] of remaining) for (let i = 0; i < count; i += 1) removed.push(line);
  return { added, removed };
}

export type PersonaPatch = Partial<Record<PersonaField, string | readonly string[]>>;

/** The protected fields a patch would change; a non-empty answer makes the patch a proposal. */
export function protectedFieldsIn(card: PersonaCard | null, patch: PersonaPatch): readonly PersonaField[] {
  return PROTECTED_PERSONA_FIELDS.filter(
    (field) => Object.hasOwn(patch, field) && JSON.stringify(patch[field]) !== JSON.stringify(card?.[field]),
  );
}

export function applyPersonaPatch(card: PersonaCard | null, patch: PersonaPatch): PersonaCard {
  const base: Record<string, string | readonly string[]> = card === null ? emptyCard() : { ...card };
  for (const [field, value] of Object.entries(patch)) base[field] = value;
  return Object.freeze(base) as PersonaCard;
}

function emptyCard(): Record<string, string | readonly string[]> {
  return {
    name: '',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    creator_notes: '',
    alternate_greetings: [],
    visual_description: '',
    tags: [],
    creator: '',
  };
}

export function activeNorthStar(items: readonly NorthStarItem[]): NorthStarItem[] {
  return items.filter((item) => item.status === 'active').sort((a, b) => a.priority - b.priority);
}

export function createNorthStarItem(
  items: readonly NorthStarItem[],
  input: { readonly id: string; readonly title: string; readonly content: string; readonly author: Author; readonly at: string },
): Result<readonly NorthStarItem[]> {
  const active = activeNorthStar(items);
  if (active.length >= MAX_NORTH_STAR_ITEMS) return invalid(`the North Star holds at most ${MAX_NORTH_STAR_ITEMS} items; retire one first`);
  if (!isNonEmptyString(input.title) || !isNonEmptyString(input.content)) return invalid('North Star title and content must be non-empty');
  const item: NorthStarItem = {
    id: input.id,
    title: input.title.trim(),
    content: input.content.trim(),
    priority: active.length,
    enabled: true,
    version: 1,
    status: 'active',
    updatedAt: input.at,
    updatedBy: input.author,
  };
  return ok([...items, item]);
}

export function reviseNorthStarItem(
  items: readonly NorthStarItem[],
  itemId: string,
  patch: { readonly title?: string; readonly content?: string; readonly enabled?: boolean },
  meta: { readonly author: Author; readonly at: string },
): Result<readonly NorthStarItem[]> {
  const current = items.find((item) => item.id === itemId && item.status === 'active');
  if (current === undefined) return invalid(`no active North Star item ${itemId}`);
  if (patch.title === undefined && patch.content === undefined && patch.enabled === undefined) {
    return invalid('north_star_update needs title, content or enabled');
  }
  if (patch.title !== undefined && !isNonEmptyString(patch.title)) return invalid('North Star title must be non-empty');
  if (patch.content !== undefined && !isNonEmptyString(patch.content)) return invalid('North Star content must be non-empty');
  return ok(
    items.map((item) =>
      item === current
        ? {
            ...item,
            title: patch.title?.trim() ?? item.title,
            content: patch.content?.trim() ?? item.content,
            enabled: patch.enabled ?? item.enabled,
            version: item.version + 1,
            updatedAt: meta.at,
            updatedBy: meta.author,
          }
        : item,
    ),
  );
}

/** Every active item must appear exactly once in the new order. */
export function reorderNorthStar(
  items: readonly NorthStarItem[],
  order: readonly string[],
  meta: { readonly author: Author; readonly at: string },
): Result<readonly NorthStarItem[]> {
  const active = activeNorthStar(items);
  const ids = new Set(active.map((item) => item.id));
  if (order.length !== active.length || new Set(order).size !== order.length || !order.every((id) => ids.has(id))) {
    return invalid('north_star_reorder must list every active item exactly once');
  }
  return ok(
    items.map((item) => {
      const priority = order.indexOf(item.id);
      if (priority === -1 || priority === item.priority) return item;
      return { ...item, priority, version: item.version + 1, updatedAt: meta.at, updatedBy: meta.author };
    }),
  );
}

/** Retiring keeps the item and its history; remaining items close ranks. */
export function retireNorthStarItem(
  items: readonly NorthStarItem[],
  itemId: string,
  meta: { readonly author: Author; readonly at: string },
): Result<readonly NorthStarItem[]> {
  const current = items.find((item) => item.id === itemId && item.status === 'active');
  if (current === undefined) return invalid(`no active North Star item ${itemId}`);
  const remaining = activeNorthStar(items).filter((item) => item.id !== itemId).map((item) => item.id);
  return ok(
    items.map((item) => {
      if (item.id === itemId) return { ...item, status: 'retired' as const, version: item.version + 1, updatedAt: meta.at, updatedBy: meta.author };
      const priority = remaining.indexOf(item.id);
      if (priority === -1 || priority === item.priority) return item;
      return { ...item, priority, version: item.version + 1, updatedAt: meta.at, updatedBy: meta.author };
    }),
  );
}
