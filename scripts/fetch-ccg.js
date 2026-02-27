#!/usr/bin/env node

/**
 * Fetches sustainability resource data from the Creative Culture Guide.
 * Source: https://www.creativecultureguide.org/map
 * API: /apis/ccg.php (internal JSON API)
 *
 * Contains ~1,400 sustainability resources: farms, stores, organizations,
 * ecovillages, community gardens, companies, etc. Global scope.
 *
 * External website URLs are extracted from the keywords field.
 * Only org-like resource types are kept (not books, films, articles, etc.).
 *
 * Usage:
 *   node scripts/fetch-ccg.js
 */

const fs = require("fs");
const path = require("path");

const API_URL = "https://www.creativecultureguide.org/apis/ccg.php";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "ccg-resources.json");
const FETCH_TIMEOUT = 30000;

const ORG_TYPES = new Set([
  "Organization", "Company", "Farm", "Store",
  "EcoVillage", "Eco Village", "Community Garden",
  "Group", "Market",
]);

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

function extractUrlFromKeywords(keywords) {
  if (!keywords) return null;
  const match = keywords.match(/https?:\/\/[^\s,]+/);
  return match ? match[0] : null;
}

const TYPE_TAGS = {
  "Organization": ["organization"],
  "Company": ["social enterprise"],
  "Farm": ["farm"],
  "Store": ["shop"],
  "EcoVillage": ["ecovillage"],
  "Eco Village": ["ecovillage"],
  "Community Garden": ["community garden"],
  "Group": ["community group"],
  "Market": ["market"],
};

const CATEGORY_TAGS = {
  "Food": "food",
  "Education & Learning": "education",
  "Health & Wellness": "health",
  "Community": "community",
  "Housing & Structures": "housing",
  "Art & Culture": "arts and culture",
  "Economics & Exchange": "alternative economy",
  "Energy": "renewable energy",
  "Water": "water",
  "Materials & Manufacturing": "sustainable manufacturing",
  "Transport": "sustainable transport",
};

function extractLocation(keywords) {
  // Keywords often start with: scope, street/city, state, country
  // e.g. "national, kutztown, pa, united states of america, organization, ..."
  // or "local, 2342, rosewall crescent, courtenay, bc, canada, organization, ..."
  if (!keywords) return { locality: "", region: "", country: "" };

  const parts = keywords.split(",").map(p => p.trim());
  // Find the type keyword to know where location ends
  const typeIdx = parts.findIndex(p =>
    ORG_TYPES.has(p.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")) ||
    ["organization", "company", "farm", "store", "ecovillage", "eco village",
     "community garden", "group", "market"].includes(p.toLowerCase())
  );

  if (typeIdx <= 1) return { locality: "", region: "", country: "" };

  // Location parts are between scope (index 0) and type keyword
  const locParts = parts.slice(1, typeIdx);
  if (locParts.length === 0) return { locality: "", region: "", country: "" };

  // Last part is usually country, second-to-last is state/region
  const country = locParts.length >= 1 ? locParts[locParts.length - 1] : "";
  const region = locParts.length >= 2 ? locParts[locParts.length - 2] : "";
  // Everything before that is locality
  const locality = locParts.length >= 3 ? locParts.slice(0, -2).join(", ") : "";

  return { locality, region, country };
}

async function main() {
  console.log("Fetching Creative Culture Guide resources...");
  const params = new URLSearchParams({
    limit: "5000",
    kind: "ccg_resources",
    sort_by: "rating",
    sort_order: "DESC",
  });

  const res = await fetch(`${API_URL}?${params}`, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }
  const json = await res.json();

  // API returns object keyed by index or array
  const data = Array.isArray(json) ? json : Object.values(json);
  console.log(`  ${data.length} total resources from API`);

  // Filter to org-like types only
  const orgEntries = data.filter(e => ORG_TYPES.has(e.type));
  console.log(`  ${orgEntries.length} org-like entries (filtered from ${data.length})`);

  // Clean and filter
  const results = [];
  let skippedNoUrl = 0;
  let skippedSocial = 0;
  let skippedNoCoords = 0;
  const seenDomains = new Set();
  let skippedDuplicate = 0;

  for (const entry of orgEntries) {
    const rawUrl = extractUrlFromKeywords(entry.keywords);
    const url = fixUrl(rawUrl);
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

    const lat = parseFloat(entry.latitude) || null;
    const lng = parseFloat(entry.longitude) || null;
    if (!lat || !lng || (lat === 0 && lng === 0)) { skippedNoCoords++; continue; }

    const typeTags = TYPE_TAGS[entry.type] || [];
    const catTag = CATEGORY_TAGS[entry.category];
    const tags = ["sustainability", ...typeTags];
    if (catTag && !tags.includes(catTag)) tags.push(catTag);

    const loc = extractLocation(entry.keywords);

    results.push({
      name: entry.title || "",
      description: (entry.description || "").trim(),
      primary_url: url,
      profile_url: `https://www.creativecultureguide.org${entry.url}`,
      latitude: lat,
      longitude: lng,
      locality: loc.locality,
      region: loc.region,
      country: loc.country,
      tags,
      source: "ccg",
    });
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`  Saved to ${OUT_FILE}`);

  // Stats
  console.log("\n--- Stats ---");
  console.log(`Total resources: ${data.length}`);
  console.log(`Org-like entries: ${orgEntries.length}`);
  console.log(`Skipped (no URL in keywords): ${skippedNoUrl}`);
  console.log(`Skipped (social media): ${skippedSocial}`);
  console.log(`Skipped (no coordinates): ${skippedNoCoords}`);
  console.log(`Skipped (duplicate domain): ${skippedDuplicate}`);
  console.log(`Final entries: ${results.length}`);

  // Type breakdown
  const typeCounts = {};
  for (const r of results) {
    for (const t of r.tags) {
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
  }
  console.log("\nTag breakdown:");
  for (const [tag, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tag}: ${count}`);
  }

  // Country breakdown (top 10)
  const countryCounts = {};
  for (const r of results) {
    const key = r.country || "(unknown)";
    countryCounts[key] = (countryCounts[key] || 0) + 1;
  }
  const topCountries = Object.entries(countryCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log("\nCountry breakdown (top 15):");
  for (const [country, count] of topCountries) {
    console.log(`  ${country}: ${count}`);
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
