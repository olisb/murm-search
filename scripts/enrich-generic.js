#!/usr/bin/env node

/**
 * Generic enrichment script for OSM profiles.
 * Takes an input file as argument, optionally exclude patterns.
 *
 * Usage:
 *   node enrich-generic.js data/osm-social_centres.json
 *   node enrich-generic.js data/osm-vegetarian_restaurants.json --exclude-names "McDonald|Burger King"
 *   node enrich-generic.js data/osm-vegetarian_restaurants.json --exclude-urls "mcdonalds|burgerking"
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const CONCURRENCY = 15;
const URL_TIMEOUT = 10000;
const NOMINATIM_DELAY = 1100;
const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeSemaphore(max) {
  let running = 0;
  const queue = [];
  return function acquire() {
    return new Promise(resolve => {
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

function extractDescriptionLight(html) {
  // Regex-based extraction — no DOM allocation, no memory leak
  const patterns = [
    /property="og:description"\s+content="([^"]{20,300})"/i,
    /content="([^"]{20,300})"\s+property="og:description"/i,
    /name="description"\s+content="([^"]{20,300})"/i,
    /content="([^"]{20,300})"\s+name="description"/i,
  ];
  for (const rx of patterns) {
    const m = html.match(rx);
    if (m) return m[1].trim();
  }
  return null;
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&zoom=3&format=json&accept-language=en`;
    const res = await fetch(url, {
      headers: { "User-Agent": "CoBot/1.0 (community directory)" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.address?.country || null;
  } catch { return null; }
}

async function main() {
  const startTime = Date.now();

  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error("Usage: node enrich-generic.js <input-file> [--exclude-names 'pattern'] [--exclude-urls 'pattern']");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  const categoryName = path.basename(inputFile, ".json").replace("osm-", "");
  const logFile = path.join(DATA_DIR, `dead-links-${categoryName}.log`);

  // Parse exclude patterns from args
  const excludeNames = [];
  const excludeUrls = [];
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === "--exclude-names" && process.argv[i + 1]) {
      excludeNames.push(new RegExp(process.argv[++i], "i"));
    } else if (process.argv[i] === "--exclude-urls" && process.argv[i + 1]) {
      excludeUrls.push(new RegExp(process.argv[++i], "i"));
    }
  }

  function shouldExclude(name, url) {
    if (excludeNames.some(rx => rx.test(name || ""))) return true;
    if (excludeUrls.some(rx => rx.test(url || ""))) return true;
    return false;
  }

  // Detect the "is a <type>" pattern used in auto-generated descriptions
  // Match auto-generated descriptions like "X is a social centre in Y"
  const singularName = categoryName.replace(/_/g, "[ _]").replace(/s$/, "");
  const descPattern = new RegExp(`is a ${singularName}`, "i");

  try { require("jsdom"); } catch {
    console.error("Missing dependency: npm install jsdom");
    process.exit(1);
  }

  console.log(`\n=== Enriching: ${categoryName} ===`);
  const allProfiles = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  console.log(`Loaded ${allProfiles.length} profiles from ${path.basename(inputFile)}`);

  // Step 1: Filter
  let filtered;
  if (excludeNames.length > 0 || excludeUrls.length > 0) {
    filtered = allProfiles.filter(p => !shouldExclude(p.name, p.primary_url));
    const excluded = allProfiles.length - filtered.length;
    console.log(`Filtered out ${excluded} excluded entries, ${filtered.length} remaining`);
  } else {
    filtered = allProfiles;
  }

  // Step 2: Dedup against existing
  const existing = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
  const existingUrls = new Set();
  for (const p of existing) {
    const norm = normalizeUrl(p.primary_url);
    if (norm) existingUrls.add(norm);
  }

  const newProfiles = [];
  let dupes = 0;
  for (const p of filtered) {
    if (!p.primary_url) continue;
    const norm = normalizeUrl(p.primary_url);
    if (norm && existingUrls.has(norm)) {
      dupes++;
    } else {
      newProfiles.push(p);
      if (norm) existingUrls.add(norm);
    }
  }
  console.log(`${dupes} duplicates skipped, ${newProfiles.length} new profiles to validate`);

  if (newProfiles.length === 0) {
    console.log("Nothing to do.");
    return { added: 0, category: categoryName };
  }

  // Step 3: Validate URLs + scrape descriptions
  const acquire = makeSemaphore(CONCURRENCY);
  const logLines = [];
  let passed = 0, failed = 0, done = 0, descImproved = 0;
  const total = newProfiles.length;

  const BATCH_SIZE = 100;
  const skipScrape = total > 5000 || process.argv.includes("--skip-scrape");
  console.log(`Validating${skipScrape ? "" : " & scraping"} ${total} URLs (concurrency=${CONCURRENCY}, batch=${BATCH_SIZE}${skipScrape ? ", HEAD-only" : ""})...`);

  async function validateOne(p) {
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
          method: skipScrape ? "HEAD" : "GET",
          signal: controller.signal,
          redirect: "follow",
          headers: { "User-Agent": "CoBot/1.0 (community directory)" },
        });
        clearTimeout(timer);

        if (res.status < 200 || res.status >= 400) {
          failed++;
          logLines.push(`FAIL ${res.status} ${p.primary_url}`);
          return null;
        }

        passed++;

        if (!skipScrape) {
          const contentType = res.headers.get("content-type") || "";
          if (contentType.includes("text/html")) {
            try {
              const html = await res.text();
              const scraped = extractDescriptionLight(html);
              if (scraped && (!p.description || descPattern.test(p.description))) {
                p.description = scraped;
                descImproved++;
              }
            } catch { /* ignore */ }
          }
        }

        return p;
      } catch (err) {
        clearTimeout(timer);
        failed++;
        logLines.push(`FAIL ${err.name === "AbortError" ? "TIMEOUT" : err.message} ${p.primary_url}`);
        return null;
      }
    } finally {
      done++;
      if (done % 50 === 0 || done === total) {
        process.stdout.write(`\r  [${categoryName}] ${done}/${total} (${passed} ok, ${failed} dead, ${descImproved} desc scraped)`);
      }
      release();
    }
  }

  const valid = [];
  for (let i = 0; i < newProfiles.length; i += BATCH_SIZE) {
    const batch = newProfiles.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(p => validateOne(p)));
    for (const r of results) { if (r) valid.push(r); }
  }
  console.log(`\n  URL validation: ${passed} passed, ${failed} failed`);
  console.log(`  Descriptions improved: ${descImproved}`);

  // Checkpoint: save valid profiles before geocoding so we never lose URL validation work
  const checkpointPath = path.join(DATA_DIR, `checkpoint-${categoryName}.json`);
  fs.writeFileSync(checkpointPath, JSON.stringify(valid, null, 2));
  console.log(`  Checkpoint saved: ${valid.length} valid profiles to ${path.basename(checkpointPath)}`);

  // Step 4: Reverse geocode missing countries
  const needsCountry = valid.filter(p => !p.country && p.latitude != null && p.longitude != null);
  console.log(`  Reverse geocoding ${needsCountry.length} profiles...`);

  const gridCache = new Map();
  let geocoded = 0, geocodeFails = 0;

  for (let i = 0; i < needsCountry.length; i++) {
    const p = needsCountry[i];
    const gridKey = `${Math.round(p.latitude)},${Math.round(p.longitude)}`;

    if (gridCache.has(gridKey)) {
      const country = gridCache.get(gridKey);
      if (country) { p.country = country; geocoded++; }
    } else {
      const country = await reverseGeocode(p.latitude, p.longitude);
      gridCache.set(gridKey, country);
      if (country) { p.country = country; geocoded++; }
      else { geocodeFails++; }
      await sleep(NOMINATIM_DELAY);
    }

    if ((i + 1) % 50 === 0 || i === needsCountry.length - 1) {
      process.stdout.write(`\r  [${categoryName}] geocode ${i + 1}/${needsCountry.length} (${geocoded} resolved, ${gridCache.size} cells cached)`);
    }
  }
  if (needsCountry.length > 0) {
    console.log(`\n  Geocoded: ${geocoded}, failed: ${geocodeFails}`);
  }

  // Step 5: Save results
  const outputOnly = process.argv.includes("--output-only");
  if (outputOnly) {
    const outPath = path.join(DATA_DIR, `enriched-${categoryName}.json`);
    fs.writeFileSync(outPath, JSON.stringify(valid, null, 2));
    console.log(`  Saved ${valid.length} enriched ${categoryName} profiles to ${path.basename(outPath)}`);
  } else {
    const before = existing.length;
    existing.push(...valid);
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(existing, null, 2));
    console.log(`  Added ${valid.length} ${categoryName} profiles: ${before} → ${existing.length}`);
  }

  // Log dead links
  if (logLines.length > 0) {
    fs.appendFileSync(logFile, logLines.join("\n") + "\n");
  }

  // Summary
  const withCountry = valid.filter(p => p.country).length;
  const withDesc = valid.filter(p => p.description && !descPattern.test(p.description)).length;
  if (valid.length > 0) {
    console.log(`  Quality: ${withCountry}/${valid.length} with country (${Math.round(withCountry / valid.length * 100)}%), ${withDesc}/${valid.length} with real description (${Math.round(withDesc / valid.length * 100)}%)`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Done in ${elapsed}s.\n`);

  return { added: valid.length, category: categoryName };
}

main().catch(err => { console.error("Fatal error:", err); process.exit(1); });
