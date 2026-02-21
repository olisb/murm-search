#!/usr/bin/env node

/**
 * Enriches marketplace profiles from OSM:
 * 1. Filters out non-community marketplaces (shopping malls, chains, etc.)
 * 2. Deduplicates against existing profiles.json
 * 3. Validates URLs by fetching pages (GET, not HEAD)
 * 4. Scrapes meta descriptions from websites
 * 5. Reverse geocodes lat/lon to fill missing country data
 * 6. Appends validated, enriched profiles to profiles.json
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const CONCURRENCY = 15;
const URL_TIMEOUT = 10000;
const NOMINATIM_DELAY = 1100;
const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const INPUT_FILE = path.join(DATA_DIR, "osm-marketplaces.json");
const LOG_FILE = path.join(DATA_DIR, "dead-links-marketplaces.log");

// Exclude patterns — shopping malls, chains, non-community venues
const EXCLUDE_NAME = [
  /\bmall\b|shopping.?cent|shopping.?plaza|galleri[ae]|galery/i,
  /\bsupermarket|hypermarket|grocery.?store/i,
  /\bfaxcopy\b/i,
  /\bauction|auktion\b/i,
  /\bcar.?boot\b/i,
  /\bconstruction|building.?material|стройматериал|baumarkt\b/i,
  /\bcopy.?shop|print.?shop/i,
];

const EXCLUDE_URL = [
  /faxcopy\./i,
  /dinbilauktion/i,
];

function shouldExclude(name, url) {
  if (EXCLUDE_NAME.some(rx => rx.test(name || ""))) return true;
  if (EXCLUDE_URL.some(rx => rx.test(url || ""))) return true;
  return false;
}

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

function extractDescription(html, url) {
  try {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    const og = doc.querySelector('meta[property="og:description"]');
    if (og && og.content && og.content.trim().length > 20) return og.content.trim().slice(0, 300);
    const meta = doc.querySelector('meta[name="description"]');
    if (meta && meta.content && meta.content.trim().length > 20) return meta.content.trim().slice(0, 300);
    const tw = doc.querySelector('meta[name="twitter:description"]');
    if (tw && tw.content && tw.content.trim().length > 20) return tw.content.trim().slice(0, 300);
    return null;
  } catch { return null; }
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

  try { require("jsdom"); } catch {
    console.error("Missing dependency: npm install jsdom");
    process.exit(1);
  }

  const allProfiles = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"));
  console.log(`Loaded ${allProfiles.length} marketplace profiles`);

  // Step 1: Filter out non-community marketplaces
  const filtered = allProfiles.filter(p => !shouldExclude(p.name, p.primary_url));
  const excluded = allProfiles.length - filtered.length;
  console.log(`Filtered out ${excluded} non-community entries, ${filtered.length} remaining`);

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
  console.log(`${dupes} duplicates skipped, ${newProfiles.length} new profiles to validate\n`);

  // Step 3: Validate URLs + scrape descriptions
  const acquire = makeSemaphore(CONCURRENCY);
  const logLines = [];
  let passed = 0, failed = 0, done = 0, descImproved = 0;
  const total = newProfiles.length;

  console.log(`Validating & scraping ${total} URLs (concurrency=${CONCURRENCY})...`);

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

          const contentType = res.headers.get("content-type") || "";
          if (contentType.includes("text/html")) {
            try {
              const html = await res.text();
              const scraped = extractDescription(html, url.href);
              if (scraped && (!p.description || p.description.includes("is a marketplace"))) {
                p.description = scraped;
                descImproved++;
              }
            } catch { /* ignore */ }
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
          process.stdout.write(`\r  ${done}/${total} (${passed} ok, ${failed} dead, ${descImproved} desc scraped)`);
        }
        release();
      }
    })
  );

  const valid = results.filter(Boolean);
  console.log(`\n\nURL validation: ${passed} passed, ${failed} failed`);
  console.log(`Descriptions improved: ${descImproved}`);

  // Step 4: Reverse geocode missing countries
  const needsCountry = valid.filter(p => !p.country && p.latitude != null && p.longitude != null);
  console.log(`\nReverse geocoding ${needsCountry.length} profiles with missing country...`);

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
      process.stdout.write(`\r  ${i + 1}/${needsCountry.length} (${geocoded} resolved, ${gridCache.size} grid cells cached)`);
    }
  }
  console.log(`\n  Geocoded: ${geocoded}, failed: ${geocodeFails}, unique cells: ${gridCache.size}`);

  // Step 5: Append to profiles.json
  const before = existing.length;
  existing.push(...valid);
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(existing, null, 2));

  console.log(`\nAdded ${valid.length} marketplace profiles: ${before} → ${existing.length}`);

  // Log dead links
  if (logLines.length > 0) {
    fs.appendFileSync(LOG_FILE, logLines.join("\n") + "\n");
    console.log(`Dead links logged to ${LOG_FILE}`);
  }

  // Summary
  const withCountry = valid.filter(p => p.country).length;
  const withDesc = valid.filter(p => p.description && !p.description.includes("is a marketplace")).length;
  console.log(`\nFinal quality:`);
  console.log(`  With country: ${withCountry}/${valid.length} (${Math.round(withCountry / valid.length * 100)}%)`);
  console.log(`  With real description: ${withDesc}/${valid.length} (${Math.round(withDesc / valid.length * 100)}%)`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s.`);
  console.log("Run 'python3 scripts/generate-embeddings.py' to rebuild embeddings.");
}

main().catch(err => { console.error("Fatal error:", err); process.exit(1); });
