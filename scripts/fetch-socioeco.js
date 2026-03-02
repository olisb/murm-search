#!/usr/bin/env node

/**
 * Fetches social/solidarity economy org data from socioeco.org.
 * Source: https://www.socioeco.org/solutions_en.html
 * API: https://www.socioeco.org/organismes-regroupement_en.json (GeoJSON)
 *
 * Contains ~600 global SSE organisations: research centres, networks,
 * advocacy groups, CSA schemes, fair trade, renewable energy, housing coops.
 *
 * Usage:
 *   node scripts/fetch-socioeco.js
 */

const fs = require("fs");
const path = require("path");

const API_URL = "https://www.socioeco.org/organismes-regroupement_en.json";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "socioeco-orgs.json");
const FETCH_TIMEOUT = 30000;

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
  // Handle " and " separated URLs — take the first one
  if (url.includes(" and ")) url = url.split(" and ")[0].trim();
  if (url.includes(";")) url = url.split(";")[0].trim();
  if (url.includes(" ")) url = url.split(" ")[0].trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

async function main() {
  console.log("Fetching socioeco.org GeoJSON...");
  const res = await fetch(API_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }
  const geojson = await res.json();
  const features = geojson.features || [];
  console.log(`  ${features.length} features in GeoJSON`);

  // Clean and filter
  const results = [];
  let skippedNoUrl = 0;
  let skippedSocial = 0;
  const seenDomains = new Set();
  let skippedDuplicate = 0;

  for (const feature of features) {
    const props = feature.properties || {};
    const url = fixUrl(props.url);
    if (!url) { skippedNoUrl++; continue; }
    if (isSkipUrl(url)) { skippedSocial++; continue; }

    let domain;
    try {
      domain = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      skippedNoUrl++;
      continue;
    }
    if (seenDomains.has(domain)) { skippedDuplicate++; continue; }
    seenDomains.add(domain);

    const coords = feature.geometry?.coordinates;
    const lng = coords ? coords[0] : null;
    const lat = coords ? coords[1] : null;

    results.push({
      name: props.name || "",
      description: "",
      primary_url: url,
      profile_url: `https://www.socioeco.org/bdf_auteur-${props.id}_en.html`,
      latitude: lat,
      longitude: lng,
      locality: "",
      region: "",
      country: "",
      tags: ["solidarity economy", "organization"],
      source: "socioeco",
    });
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`  Saved to ${OUT_FILE}`);

  // Stats
  console.log("\n--- Stats ---");
  console.log(`GeoJSON features: ${features.length}`);
  console.log(`Skipped (no URL): ${skippedNoUrl}`);
  console.log(`Skipped (social media): ${skippedSocial}`);
  console.log(`Skipped (duplicate domain): ${skippedDuplicate}`);
  console.log(`Final entries: ${results.length}`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
