#!/bin/bash
set -e

# nightcrawl — CoBot's overnight data pipeline
# Fetches all sources, merges, validates every URL, then rebuilds embeddings.
# No node gets published unless its website is alive.

echo "=== nightcrawl ==="
echo ""

echo "Step 1/6: Fetching Murmurations org profiles..."
node scripts/fetch-profiles.js
echo ""

echo "Step 2/6: Fetching KVM profiles..."
node scripts/fetch-kvm-profiles.js
echo ""

echo "Step 3/6: Fetching all OpenStreetMap categories..."
node scripts/fetch-osm.js
echo ""

echo "Step 4/6: Merging all profiles..."
node scripts/merge-profiles.js
echo ""

echo "Step 5/6: Validating every URL (removing dead links)..."
node scripts/validate-urls.js
echo ""

echo "Step 6/6: Generating embeddings..."
python3 scripts/generate-embeddings.py
echo ""

echo "=== nightcrawl complete ==="
