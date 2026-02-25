#!/usr/bin/env node

/**
 * Fetches hackerspace data from the SpaceAPI directory.
 * Source: https://directory.spaceapi.io/
 *
 * Phase 1: Fetches the directory (name → endpoint mapping).
 * Phase 2: Fetches each endpoint to get website, location, description.
 * Phase 3: Deduplicates against existing profiles, cleans, and outputs.
 *
 * Usage:
 *   node scripts/fetch-spaceapi.js
 */

const fs = require("fs");
const path = require("path");

const DIRECTORY_URL = "https://directory.spaceapi.io/";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "spaceapi-hackerspaces.json");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const CONCURRENCY = 10;
const FETCH_TIMEOUT = 10000;

const SKIP_DOMAINS = new Set([
  "facebook.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "tiktok.com", "linkedin.com",
]);

function isSkipUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return SKIP_DOMAINS.has(host) || SKIP_DOMAINS.has(host.split(".").slice(-2).join("."));
  } catch {
    return true;
  }
}

function fixUrl(url) {
  if (!url) return null;
  url = url.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

async function fetchEndpoint(name, endpointUrl) {
  try {
    const res = await fetch(endpointUrl, {
      headers: { "User-Agent": "CoBot/1.0 (community directory)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      name: data.space || data.name || name,
      url: data.url || data.website || null,
      description: data.description || "",
      lat: data.location?.lat ?? null,
      lon: data.location?.lon ?? null,
      address: data.location?.address || "",
      contact: data.contact || {},
    };
  } catch {
    return null;
  }
}

async function main() {
  // Phase 1: Fetch directory
  console.log("Phase 1: Fetching SpaceAPI directory...");
  const res = await fetch(DIRECTORY_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }
  const directory = await res.json();
  const entries = Object.entries(directory);
  console.log(`  ${entries.length} spaces in directory`);

  // Phase 2: Fetch each endpoint
  console.log(`Phase 2: Fetching endpoints (concurrency ${CONCURRENCY})...`);
  const results = [];
  let fetched = 0;
  let succeeded = 0;

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(([name, url]) => fetchEndpoint(name, url))
    );

    for (let j = 0; j < batch.length; j++) {
      fetched++;
      if (batchResults[j]) {
        succeeded++;
        results.push(batchResults[j]);
      }
    }

    if (fetched % 50 < CONCURRENCY || fetched === entries.length) {
      process.stdout.write(`\r  ${fetched}/${entries.length} fetched, ${succeeded} succeeded`);
    }
  }
  console.log();

  // Phase 3: Clean, deduplicate, output
  console.log("Phase 3: Cleaning and deduplicating...");

  // Load existing profiles for dedup
  const existingProfiles = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));
  const existingDomains = new Set();
  for (const p of existingProfiles) {
    const d = domainOf(p.primary_url);
    if (d) existingDomains.add(d);
  }
  console.log(`  ${existingDomains.size} existing domains for dedup`);

  const seenDomains = new Set();
  const cleaned = [];
  let skippedNoUrl = 0;
  let skippedSocial = 0;
  let skippedDuplicate = 0;
  let skippedExisting = 0;

  for (const r of results) {
    const url = fixUrl(r.url);
    if (!url) { skippedNoUrl++; continue; }
    if (isSkipUrl(url)) { skippedSocial++; continue; }

    const domain = domainOf(url);
    if (!domain) { skippedNoUrl++; continue; }

    if (existingDomains.has(domain)) { skippedExisting++; continue; }
    if (seenDomains.has(domain)) { skippedDuplicate++; continue; }
    seenDomains.add(domain);

    // Parse country from address (last segment)
    const addrParts = r.address.split(",").map(s => s.trim()).filter(Boolean);
    const country = addrParts.length > 0 ? addrParts[addrParts.length - 1] : "";
    const locality = addrParts.length >= 2 ? addrParts[addrParts.length - 2].replace(/^\d{4,}\s*/, "") : "";

    cleaned.push({
      name: r.name,
      description: r.description,
      primary_url: url,
      profile_url: url,
      latitude: r.lat,
      longitude: r.lon,
      locality: locality,
      region: "",
      country: country,
      tags: ["hackerspace"],
      source: "spaceapi",
    });
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(cleaned, null, 2));
  console.log(`  Saved to ${OUT_FILE}`);

  // Stats
  console.log("\n--- Stats ---");
  console.log(`Directory entries: ${entries.length}`);
  console.log(`Endpoints fetched: ${succeeded}/${fetched}`);
  console.log(`Skipped (no URL): ${skippedNoUrl}`);
  console.log(`Skipped (social media): ${skippedSocial}`);
  console.log(`Skipped (already in DB): ${skippedExisting}`);
  console.log(`Skipped (duplicate domain): ${skippedDuplicate}`);
  console.log(`Final new entries: ${cleaned.length}`);

  // Country breakdown (top 10)
  const countryCounts = {};
  for (const r of cleaned) {
    const key = r.country || "(unknown)";
    countryCounts[key] = (countryCounts[key] || 0) + 1;
  }
  const topCountries = Object.entries(countryCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log("\nCountry breakdown (top 10):");
  for (const [country, count] of topCountries) {
    console.log(`  ${country}: ${count}`);
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
