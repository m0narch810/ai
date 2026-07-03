"""
Extract all PDFs → knowledge/*.txt, chunk them, compute semantic embeddings,
save knowledge/chunks.json + knowledge/embeddings.npy for zero-overhead retrieval.

Run with: npm run extract-knowledge
"""
import sys, re, os, json
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    import pypdf
except ImportError:
    print("ERROR: pip install pypdf"); sys.exit(1)

try:
    from sentence_transformers import SentenceTransformer
    import numpy as np
except ImportError:
    print("ERROR: pip install sentence-transformers numpy"); sys.exit(1)

ROOT          = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF_DIR       = os.path.join(ROOT, "pdfs")
KNOWLEDGE_DIR = os.path.join(ROOT, "knowledge")
os.makedirs(KNOWLEDGE_DIR, exist_ok=True)

CHUNK_SIZE  = 900
CHUNK_OVERLAP = 150
MIN_CHUNK   = 200

PDFS = {
    "YYY Practitioner's Guide to Modern Markets.pdf": "yyy_guide",
    "Regime Engine Altaris.pdf":                      "regime_engine_altaris",
    "Volatility Sector (2).pdf":                      "volatility_sector",
    "garch (4).pdf":                                  "garch_reference",
    "litzenberger (5).pdf":                           "litzenberger",
    "how to predict market open by dxrk (8).pdf":     "dxrk_market_open",
    "daily macro bias by dxrk (3).pdf":               "dxrk_macro_bias",
    "hp doc.pdf":                                     "hp_doc",
}

def extract_pdf(path):
    r = pypdf.PdfReader(path)
    pages = []
    for i, page in enumerate(r.pages):
        raw = page.extract_text() or ""
        text = re.sub(r"[\s]+", " ", raw).strip()
        text = re.sub(r"([.!?])\s+([A-Z])", r"\1\n\2", text)
        text = re.sub(r"(\d+\.\d+\s+[A-Z])", r"\n\n\1", text)
        text = re.sub(r"(Chapter\s+\d+[:\s])", r"\n\n\1", text)
        if text.strip():
            pages.append(f"[p{i+1}] {text}")
    return "\n\n".join(pages)

def chunk_text(text, source):
    chunks = []
    for i in range(0, len(text), CHUNK_SIZE - CHUNK_OVERLAP):
        c = text[i:i + CHUNK_SIZE].strip()
        if len(c) >= MIN_CHUNK:
            chunks.append({"source": source, "text": c})
    return chunks

# ── 1. Extract PDFs ──────────────────────────────────────────────────────────
all_chunks = []
for pdf_name, slug in PDFS.items():
    pdf_path = os.path.join(PDF_DIR, pdf_name)
    if not os.path.exists(pdf_path):
        print(f"SKIP  {pdf_name} (not found)"); continue
    try:
        text = extract_pdf(pdf_path)
        out  = os.path.join(KNOWLEDGE_DIR, f"{slug}.txt")
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        chunks = chunk_text(text, slug)
        all_chunks.extend(chunks)
        print(f"OK    {slug}: {len(text):,} chars → {len(chunks)} chunks")
    except Exception as e:
        print(f"FAIL  {pdf_name}: {e}")

print(f"\n{len(all_chunks)} chunks total — computing embeddings...")

# ── 2. Embed all chunks ──────────────────────────────────────────────────────
model = SentenceTransformer("all-MiniLM-L6-v2")
texts = [c["text"] for c in all_chunks]
embeddings = model.encode(texts, show_progress_bar=True, batch_size=64,
                          normalize_embeddings=True)  # pre-normalize for fast cosine

# ── 3. Save ──────────────────────────────────────────────────────────────────
chunks_path = os.path.join(KNOWLEDGE_DIR, "chunks.json")
emb_path    = os.path.join(KNOWLEDGE_DIR, "embeddings.npy")

with open(chunks_path, "w", encoding="utf-8") as f:
    json.dump(all_chunks, f, ensure_ascii=False)
np.save(emb_path, embeddings.astype("float32"))

print(f"\nSaved {len(all_chunks)} chunks → {chunks_path}")
print(f"Saved {embeddings.shape} float32 embeddings → {emb_path}")
print(f"Index size: {os.path.getsize(emb_path) / 1024:.0f} KB")
