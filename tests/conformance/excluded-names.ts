/**
 * The names of the subsystems Lite leaves behind, as words: an identifier or
 * a path segment names one when one of its words (or two adjacent words) is
 * an excluded subsystem's name. Shared by the absence test and the live tool
 * catalog check of the host-driven turn test.
 */
/** Words that name an excluded subsystem; matched against the words of an identifier or a path segment. */
const EXCLUDED_WORDS = new Set([
  'wiki', 'wikis', 'shard', 'shards', 'fleet', 'fleets', 'charge', 'charges', 'gateway', 'gateways',
  'cogsec', 'channels', 'skill', 'skills', 'discord', 'redis',
]);
/** Excluded subsystems whose name is two words. */
const EXCLUDED_PAIRS: readonly (readonly [string, string])[] = [
  ['findings', 'bus'],
  ['finding', 'bus'],
  ['gateway', 'server'],
  ['cog', 'sec'],
];

/** The words of an identifier or file name: camelCase, PascalCase, snake_case, kebab-case and dots split apart. */
export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

export function excludedName(name: string): string | null {
  const words = wordsOf(name);
  const single = words.find((w) => EXCLUDED_WORDS.has(w));
  if (single !== undefined) return single;
  for (let i = 0; i + 1 < words.length; i += 1) {
    const pair = EXCLUDED_PAIRS.find(([a, b]) => words[i] === a && words[i + 1] === b);
    if (pair !== undefined) return pair.join(' ');
  }
  return null;
}
