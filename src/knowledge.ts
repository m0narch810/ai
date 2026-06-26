/**
 * Semantic knowledge retrieval — cosine similarity over pre-computed
 * sentence-transformer embeddings of the PDF knowledge base.
 *
 * Embeddings are computed ONCE by `npm run extract-knowledge` and saved to
 * knowledge/embeddings.npy + knowledge/chunks.json. At query time this module
 * spawns a tiny Python process (~1-2s) that embeds the query and returns the
 * top-K most semantically similar passages as JSON.
 *
 * Compared to BM25: finds conceptually related passages even when they use
 * different terminology (e.g. "initiative activity" ≈ "trending regime").
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts");
const RETRIEVE_PY = path.join(SCRIPTS_DIR, "retrieve-knowledge.py");

export interface KnowledgeExcerpt { source: string; excerpt: string; score: number; }

/**
 * Retrieve the topK most semantically relevant knowledge-base passages for a
 * free-text query. Returns [] if the index hasn't been built yet or Python fails.
 */
export function retrieveKnowledge(query: string, topK = 5): KnowledgeExcerpt[] {
  const result = spawnSync("python", [RETRIEVE_PY, query, String(topK)], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.status !== 0 || !result.stdout?.trim()) return [];
  try {
    return JSON.parse(result.stdout) as KnowledgeExcerpt[];
  } catch {
    return [];
  }
}

