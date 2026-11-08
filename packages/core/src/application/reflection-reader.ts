import type { AuthoredReflectionPort } from '../emotion/index.ts';
import type { ReflectionPort } from '../journals/index.ts';
import { ok } from '../shared/index.ts';

/**
 * The self-model's narrow read of the journals' reflection records. A
 * reflection is recorded only from a self turn (`recordReflection` refuses any
 * other audience), so its source is the self audience; authorship is the
 * record's own, and the self-state context renders only the companion's own
 * words as authored reflection.
 */
export function createReflectionReader(reflections: ReflectionPort): AuthoredReflectionPort {
  return {
    async recent(limit) {
      const listed = await reflections.list(limit);
      if (!listed.ok) return listed;
      return ok(listed.value.map((r) => ({ id: r.id, text: r.text, author: r.author, source: { kind: 'self' } as const, createdAt: r.createdAt })));
    },
  };
}
