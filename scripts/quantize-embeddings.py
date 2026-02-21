#!/usr/bin/env python3
"""
Quantize Float32 embeddings to Int8 for reduced server memory.

Reads:  data/embeddings.bin (Float32, N * 384 floats)
Writes: data/embeddings-int8.bin (Int8, N * 384 bytes)
        data/embeddings-scales.bin (Float32, N * 2 floats — min, max per vector)
"""

import numpy as np
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
EMBED_DIM = 384


def main():
    input_path = DATA_DIR / "embeddings.bin"
    print(f"Reading {input_path}...")
    raw = np.fromfile(input_path, dtype=np.float32)
    n = len(raw) // EMBED_DIM
    print(f"  {n} vectors, {EMBED_DIM} dimensions")
    embeddings = raw.reshape(n, EMBED_DIM)

    # Per-vector min/max quantization to Int8 [-128, 127]
    print("Quantizing Float32 → Int8...")
    mins = embeddings.min(axis=1, keepdims=True)
    maxs = embeddings.max(axis=1, keepdims=True)
    ranges = maxs - mins
    # Avoid division by zero for zero-range vectors
    ranges[ranges == 0] = 1.0

    # Scale to [0, 255] then shift to [-128, 127]
    scaled = (embeddings - mins) / ranges * 255.0
    quantized = np.clip(np.round(scaled) - 128, -128, 127).astype(np.int8)

    # Save Int8 embeddings
    out_int8 = DATA_DIR / "embeddings-int8.bin"
    quantized.tofile(out_int8)
    print(f"  Saved {out_int8} ({out_int8.stat().st_size / 1e6:.1f} MB)")

    # Save scales (min, max per vector as Float32 pairs)
    scales = np.column_stack([mins.flatten(), maxs.flatten()]).astype(np.float32)
    out_scales = DATA_DIR / "embeddings-scales.bin"
    scales.tofile(out_scales)
    print(f"  Saved {out_scales} ({out_scales.stat().st_size / 1e6:.1f} MB)")

    # Verify accuracy
    print("\nVerifying quantization accuracy...")
    # Dequantize a sample and check cosine similarity
    sample_idx = np.random.choice(n, min(1000, n), replace=False)
    errors = []
    for i in sample_idx:
        orig = embeddings[i]
        mn, mx = scales[i]
        rng = mx - mn if mx != mn else 1.0
        dequant = (quantized[i].astype(np.float32) + 128) / 255.0 * rng + mn
        cos = np.dot(orig, dequant) / (np.linalg.norm(orig) * np.linalg.norm(dequant) + 1e-10)
        errors.append(1.0 - cos)
    mean_err = np.mean(errors)
    max_err = np.max(errors)
    print(f"  Mean cosine error: {mean_err:.6f}")
    print(f"  Max cosine error:  {max_err:.6f}")

    original_size = input_path.stat().st_size
    new_size = out_int8.stat().st_size + out_scales.stat().st_size
    print(f"\nSize reduction: {original_size / 1e6:.1f} MB → {new_size / 1e6:.1f} MB ({new_size / original_size * 100:.0f}%)")


if __name__ == "__main__":
    main()
