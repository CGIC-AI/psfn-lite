/** Deterministic test embeddings (no test-runner imports: child-process fixtures load them). */
import { ok, type EmbeddingPort } from '../../packages/pi/src/index.ts';

export const EMBEDDING_DIMS = 16;

/** Deterministic vectors: a fixed function of the text, never a stand-in for a missing provider. */
export function vectorFor(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMS).fill(0);
  for (let index = 0; index < text.length; index += 1) vector[index % EMBEDDING_DIMS]! += text.charCodeAt(index) / 1000;
  vector[0]! += 1;
  return vector;
}

export const deterministicEmbeddings: EmbeddingPort = { embed: (texts) => Promise.resolve(ok(texts.map(vectorFor))) };
