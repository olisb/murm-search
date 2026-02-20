#!/usr/bin/env node

/**
 * Adds a new OSM category to the existing curated dataset.
 * Only validates URLs for NEW nodes — existing profiles are untouched.
 *
 * Steps:
 *   1. Fetch the category from OSM (via fetch-osm.js output file)
 *   2. Deduplicate against existing profiles.json
 *   3. Validate URLs only for new nodes
 *   4. Append validated nodes to profiles.json
 *   5. Copy to public/data
 *
 * Usage:
 *   node scripts/add-osm-category.js cooperatives
 *   node scripts/add-osm-category.js repair_cafes
 *   node scripts/add-osm-category.js   # processes all categories with existing output files
 *
 * Run generate-embeddings.py separately after all categories are added.
 */

const fs = require("fs");
const path = require("path");

const CONCURRENCY = 15;
const URL_TIMEOUT = 8000;
const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");

function makeSemaphore(max) {
  let running = 0;
  const queue = [];
  return function acquire() {
    return new Promise((resolve) => {
      const tryRun = () => {
        if (running < max) {
          running++;
          resolve(() => { running--; if (queue.length > 0) queue.shift()(); });
        } else {
          queue.push(tryRun);
        }
      };
      tryRun();
    });
  };
}

function normalizeUrl(url) {
  if (!url) return null;
  return url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

async function validateNewProfiles(newProfiles) {
  const acquire = makeSemaphore(CONCURRENCY);
  const logLines = [];
  let passed = 0, failed = 0, done = 0;
  const total = newProfiles.length;

  console.log(`  Validating ${total} new URLs (concurrency=${CONCURRENCY}, timeout=${URL_TIMEOUT}ms)...`);

  const results = await Promise.all(
    newProfiles.map(async (p) => {
      const release = await acquire();
      try {
        let url;
        try { url = new URL(p.primary_url); } catch {
          failed++;
          logLines.push(`FAIL bad_url ${p.primary_url}`);
          return null;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), URL_TIMEOUT);
        try {
          const res = await fetch(url.href, {
            method: "HEAD",
            signal: controller.signal,
            redirect: "follow",
          });
          clearTimeout(timer);
          if (res.status >= 200 && res.status < 400) { passed++; return p; }
          else { failed++; logLines.push(`FAIL ${res.status} ${p.primary_url}`); return null; }
        } catch (err) {
          clearTimeout(timer);
          failed++;
          logLines.push(`FAIL ${err.name === "AbortError" ? "TIMEOUT" : err.message} ${p.primary_url}`);
          return null;
        }
      } finally {
        done++;
        if (done % 50 === 0 || done === total) {
          process.stdout.write(`\r    ${done}/${total} (${passed} ok, ${failed} dead)`);
        }
        release();
      }
    })
  );

  console.log(`\n  Validation: ${passed} passed, ${failed} failed`);
  return { valid: results.filter(Boolean), logLines };
}

async function processCategory(categoryFile, profiles, existingUrls) {
  const label = path.basename(categoryFile, ".json");
  const filePath = path.join(DATA_DIR, categoryFile);

  if (!fs.existsSync(filePath)) {
    console.log(`\n[${label}] File not found — run "node scripts/fetch-osm.js ${label.replace("osm-", "")}" first`);
    return { added: 0, logLines: [] };
  }

  const candidates = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  console.log(`\n[${label}] ${candidates.length} candidates`);

  // Dedup against existing
  const newProfiles = [];
  let dupes = 0;
  for (const p of candidates) {
    if (!p.primary_url) continue;
    const norm = normalizeUrl(p.primary_url);
    if (norm && existingUrls.has(norm)) {
      dupes++;
    } else {
      newProfiles.push(p);
      if (norm) existingUrls.add(norm); // prevent cross-category dupes too
    }
  }
  console.log(`  ${newProfiles.length} new, ${dupes} already in dataset`);

  if (newProfiles.length === 0) {
    return { added: 0, logLines: [] };
  }

  // Validate URLs for new profiles only
  const { valid, logLines } = await validateNewProfiles(newProfiles);

  // Append to profiles array
  profiles.push(...valid);
  console.log(`  Added ${valid.length} verified profiles`);

  return { added: valid.length, logLines };
}

async function main() {
  const startTime = Date.now();
  const requested = process.argv[2];

  // Discover available OSM files
  const allOsmFiles = fs.readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("osm-") && f.endsWith(".json"))
    .sort();

  const filesToProcess = requested
    ? allOsmFiles.filter((f) => f === `osm-${requested}.json`)
    : allOsmFiles;

  if (filesToProcess.length === 0) {
    console.error(requested
      ? `No file found: data/osm-${requested}.json — run "node scripts/fetch-osm.js ${requested}" first`
      : "No osm-*.json files found in data/");
    process.exit(1);
  }

  console.log(`Processing ${filesToProcess.length} OSM file(s): ${filesToProcess.join(", ")}`);

  const profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
  console.log(`Existing dataset: ${profiles.length} profiles`);

  // Build URL index from existing profiles
  const existingUrls = new Set();
  for (const p of profiles) {
    const norm = normalizeUrl(p.primary_url);
    if (norm) existingUrls.add(norm);
  }

  let totalAdded = 0;
  const allLogLines = [];

  for (const file of filesToProcess) {
    const { added, logLines } = await processCategory(file, profiles, existingUrls);
    totalAdded += added;
    allLogLines.push(...logLines);
  }

  // Save updated profiles
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));

  // Log dead links
  if (allLogLines.length > 0) {
    const logFile = path.join(DATA_DIR, "dead-links.log");
    fs.appendFileSync(logFile, allLogLines.join("\n") + "\n");
    console.log(`\nDead links appended to ${logFile}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s: ${totalAdded} new profiles added (${profiles.length} total)`);
  console.log("Run 'python3 scripts/generate-embeddings.py' to rebuild embeddings.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
