#!/usr/bin/env node

/**
 * Fetches cooperative/solidarity economy data from BlackSocialists.us Dual Power Map.
 * Source: https://blacksocialists.us/dual-power-map
 * API: https://blacksocialists.us/api/wsde
 *
 * Contains worker co-ops, mutual aid orgs, credit unions, community land trusts,
 * and tenant organizations across the US.
 *
 * Usage:
 *   node scripts/fetch-dualpower.js
 */

const fs = require("fs");
const path = require("path");

const API_URL = "https://blacksocialists.us/api/wsde";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "dualpower-orgs.json");
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
  // Remove "(Work)" suffix that appears in some entries
  url = url.replace(/\s*\(Work\)\s*$/i, "").trim();
  if (!url || url === "NULL") return null;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

const TYPE_TAGS = {
  wsde: ["worker cooperative"],
  tenant: ["tenant organization", "housing"],
  mutual: ["mutual aid"],
  clt: ["community land trust"],
  fcu: ["credit union"],
  wstr: ["worker cooperative"],
  sbdc: ["small business support"],
};

async function main() {
  console.log("Fetching Dual Power Map data...");
  const res = await fetch(API_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }
  const json = await res.json();
  const data = json.data || json;
  console.log(`  ${data.length} entries from API`);

  // Clean and filter
  const results = [];
  let skippedNoUrl = 0;
  let skippedSocial = 0;
  const seenDomains = new Set();
  let skippedDuplicate = 0;

  for (const entry of data) {
    const url = fixUrl(entry.normURL || entry.website);
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

    const lat = parseFloat(entry.lat) || null;
    const lng = parseFloat(entry.lng) || null;

    const typeTags = TYPE_TAGS[entry.type] || [];
    const tags = ["cooperative", ...typeTags];

    // Build state name for region
    const state = entry.state || "";

    results.push({
      name: entry.title || "",
      description: "",
      primary_url: url,
      profile_url: `https://blacksocialists.us/dual-power-map`,
      latitude: lat,
      longitude: lng,
      locality: entry.city || "",
      region: state,
      country: "United States",
      tags,
      source: "dualpower",
    });
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`  Saved to ${OUT_FILE}`);

  // Stats
  console.log("\n--- Stats ---");
  console.log(`API entries: ${data.length}`);
  console.log(`Skipped (no URL): ${skippedNoUrl}`);
  console.log(`Skipped (social media): ${skippedSocial}`);
  console.log(`Skipped (duplicate domain): ${skippedDuplicate}`);
  console.log(`Final entries: ${results.length}`);

  // Type breakdown
  const typeCounts = {};
  for (const entry of data) {
    const t = entry.type || "(unknown)";
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  console.log("\nType breakdown:");
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  // State breakdown (top 10)
  const stateCounts = {};
  for (const r of results) {
    const key = r.region || "(unknown)";
    stateCounts[key] = (stateCounts[key] || 0) + 1;
  }
  const topStates = Object.entries(stateCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log("\nState breakdown (top 10):");
  for (const [state, count] of topStates) {
    console.log(`  ${state}: ${count}`);
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
