#!/usr/bin/env python3
"""
Generate embeddings for Murmurations profiles using sentence-transformers.
Outputs:
  - data/profiles-with-embeddings.json  (full array with embedding field)
  - data/embeddings.bin                 (flat Float32Array binary for fast browser loading)
  - data/profiles-meta.json             (metadata without embeddings for the UI)
"""

import json
import struct
import sys
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

DATA_DIR = Path(__file__).parent.parent / "data"
INPUT_FILE = DATA_DIR / "profiles.json"
MODEL_NAME = "all-MiniLM-L6-v2"
BATCH_SIZE = 256


def build_text_chunk(profile: dict) -> str:
    """Build a searchable text representation of a profile."""
    parts = []
    if profile.get("name"):
        parts.append(profile["name"])
    if profile.get("description"):
        parts.append(profile["description"])
    if profile.get("tags"):
        parts.append(" ".join(profile["tags"]))
    if profile.get("locality"):
        parts.append(profile["locality"])
    if profile.get("region"):
        parts.append(profile["region"])
    if profile.get("country"):
        parts.append(profile["country"])
    return " ".join(parts)


def main():
    print(f"Loading profiles from {INPUT_FILE}...")
    profiles = json.loads(INPUT_FILE.read_text())
    print(f"  {len(profiles)} profiles loaded.\n")

    # Build text chunks
    texts = [build_text_chunk(p) for p in profiles]

    # Load model
    print(f"Loading model: {MODEL_NAME}...")
    model = SentenceTransformer(MODEL_NAME)
    print(f"  Embedding dimension: {model.get_sentence_embedding_dimension()}\n")

    # Generate embeddings
    print(f"Generating embeddings (batch_size={BATCH_SIZE})...")
    embeddings = model.encode(
        texts,
        batch_size=BATCH_SIZE,
        show_progress_bar=True,
        normalize_embeddings=True,  # pre-normalize for cosine similarity
    )
    print(f"  Shape: {embeddings.shape}\n")

    # Save profiles-with-embeddings.json
    print("Saving profiles-with-embeddings.json...")
    for i, profile in enumerate(profiles):
        profile["embedding"] = embeddings[i].tolist()
    out_full = DATA_DIR / "profiles-with-embeddings.json"
    out_full.write_text(json.dumps(profiles))
    print(f"  Saved to {out_full} ({out_full.stat().st_size / 1e6:.1f} MB)")

    # Save embeddings.bin (flat Float32Array)
    print("Saving embeddings.bin...")
    out_bin = DATA_DIR / "embeddings.bin"
    flat = embeddings.astype(np.float32).tobytes()
    out_bin.write_bytes(flat)
    print(f"  Saved to {out_bin} ({out_bin.stat().st_size / 1e6:.1f} MB)")

    # Save profiles-meta.json (without embeddings)
    print("Saving profiles-meta.json...")
    meta = []
    for profile in profiles:
        p = {k: v for k, v in profile.items() if k != "embedding"}
        meta.append(p)
    out_meta = DATA_DIR / "profiles-meta.json"
    out_meta.write_text(json.dumps(meta))
    print(f"  Saved to {out_meta} ({out_meta.stat().st_size / 1e6:.1f} MB)")

    dim = embeddings.shape[1]
    print(f"\nDone. {len(profiles)} profiles, {dim}-dim embeddings.")
    print(f"Files in {DATA_DIR}/:")
    print(f"  profiles-with-embeddings.json")
    print(f"  embeddings.bin")
    print(f"  profiles-meta.json")


if __name__ == "__main__":
    main()
