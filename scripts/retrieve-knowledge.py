"""
Query the pre-computed knowledge index.
Usage: python scripts/retrieve-knowledge.py "<query>" [top_k]
Outputs: JSON array of {source, excerpt, score}

Called by src/knowledge.ts at each scoring cycle.
The model loads in ~1-2s on warm cache; embeddings.npy loads near-instantly.
"""
import sys, os, json
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

if len(sys.argv) < 2:
    print("[]"); sys.exit(0)

query  = sys.argv[1]
top_k  = int(sys.argv[2]) if len(sys.argv) > 2 else 5

ROOT          = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KNOWLEDGE_DIR = os.path.join(ROOT, "knowledge")
CHUNKS_PATH   = os.path.join(KNOWLEDGE_DIR, "chunks.json")
EMB_PATH      = os.path.join(KNOWLEDGE_DIR, "embeddings.npy")

if not os.path.exists(CHUNKS_PATH) or not os.path.exists(EMB_PATH):
    # Index not built yet — fall back to empty (scorer won't crash)
    print("[]"); sys.exit(0)

try:
    import numpy as np
    from sentence_transformers import SentenceTransformer

    chunks     = json.load(open(CHUNKS_PATH, encoding="utf-8"))
    embeddings = np.load(EMB_PATH)          # already normalized (float32)

    model     = SentenceTransformer("all-MiniLM-L6-v2")
    q_emb     = model.encode([query], normalize_embeddings=True)[0]  # (384,)

    # Cosine similarity = dot product (both sides normalized)
    scores    = embeddings @ q_emb          # (n_chunks,)

    top_idx   = scores.argsort()[::-1][:top_k]
    results   = [
        {"source": chunks[i]["source"], "excerpt": chunks[i]["text"], "score": float(scores[i])}
        for i in top_idx
        if scores[i] > 0.15          # discard low-confidence matches
    ]
    print(json.dumps(results, ensure_ascii=False))

except Exception as e:
    sys.stderr.write(f"retrieve-knowledge error: {e}\n")
    print("[]")
