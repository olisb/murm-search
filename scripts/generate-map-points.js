#!/usr/bin/env node
/**
 * Generate lightweight map-points.json for background map dots.
 * Extracts only lat/lon + popup fields from profiles-meta.json.
 *
 * Reads:  data/profiles-meta.json
 * Writes: data/map-points.json
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const INPUT = path.join(DATA_DIR, "profiles-meta.json");
const OUTPUT = path.join(DATA_DIR, "map-points.json");

const profiles = JSON.parse(fs.readFileSync(INPUT, "utf8"));
console.log(`Loaded ${profiles.length} profiles`);

const points = [];
let skipped = 0;

for (const p of profiles) {
  if (p.latitude == null || p.longitude == null) {
    skipped++;
    continue;
  }
  const loc = [p.locality, p.region, p.country].filter(Boolean).join(", ");
  points.push({
    lat: p.latitude,
    lon: p.longitude,
    name: p.name || "Unknown",
    url: p.primary_url || null,
    loc: loc || null,
    src: p.source || "murmurations",
  });
}

const json = JSON.stringify(points);
fs.writeFileSync(OUTPUT, json);

const sizeMB = (Buffer.byteLength(json) / 1048576).toFixed(1);
console.log(`Written ${points.length} map points (skipped ${skipped} without coords)`);
console.log(`Output: ${OUTPUT} (${sizeMB} MB)`);
