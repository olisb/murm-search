#!/usr/bin/env node

/**
 * Fetches transition initiative data from Transiscope (transiscope.gogocarto.fr).
 * Source: https://transiscope.org/
 * API: https://transiscope.gogocarto.fr/api/elements.json (GoGoCarto platform)
 *
 * Contains ~48,000 French/Belgian transition initiatives: organic farms,
 * repair cafes, community gardens, zero waste shops, ecovillages, CSA,
 * solidarity economy orgs, etc. Aggregates data from ~30 partner sources.
 *
 * Usage:
 *   node scripts/fetch-transiscope.js
 */

const fs = require("fs");
const path = require("path");

const API_URL = "https://transiscope.gogocarto.fr/api/elements.json";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "transiscope.json");
const FETCH_TIMEOUT = 120000;

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
  if (Array.isArray(url)) url = url[0];
  if (typeof url !== "string") return null;
  url = url.trim();
  if (!url || url === "NULL") return null;
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

const CATEGORY_TAGS = {
  "Agriculture et alimentation": "sustainable agriculture",
  "Fabriquer, réparer, zéro déchets": "repair and reuse",
  "Économie Sociale et Solidaire": "solidarity economy",
  "Culture, Médias et Lien social": "community",
  "Espaces de rencontres et de lien social": "community space",
  "Eau, nature et biodiversité": "nature and biodiversity",
  "Éducation et formation": "education",
  "Habitat et oasis": "ecovillage",
  "Transport et mobilité": "sustainable transport",
  "Énergie": "renewable energy",
  "Finance éthique": "ethical finance",
  "Numérique et technologie": "technology",
  "Santé et bien-être": "health",
  "Gouvernance et démocratie": "governance",
};

function buildTags(categories) {
  const tags = ["transition"];
  const seen = new Set(tags);
  for (const cat of categories || []) {
    const tag = CATEGORY_TAGS[cat];
    if (tag && !seen.has(tag)) {
      tags.push(tag);
      seen.add(tag);
    }
  }
  return tags;
}

async function main() {
  console.log("Fetching Transiscope data (this is a large download ~85MB)...");
  const res = await fetch(API_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }
  const json = await res.json();
  const data = json.data || [];
  console.log(`  ${data.length} entries from API`);

  // Clean and filter
  const results = [];
  let skippedNoUrl = 0;
  let skippedSocial = 0;
  let skippedNoCoords = 0;
  const seenDomains = new Set();
  let skippedDuplicate = 0;

  for (const entry of data) {
    const url = fixUrl(entry.website);
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

    const lat = entry.geo?.latitude || null;
    const lng = entry.geo?.longitude || null;
    if (!lat || !lng) { skippedNoCoords++; continue; }

    const categories = entry.categories || [];
    const tags = buildTags(categories);
    const locality = entry.address?.addressLocality || "";
    const country = entry.address?.addressCountry === "FR" ? "France"
      : entry.address?.addressCountry === "BE" ? "Belgium"
      : entry.address?.addressCountry || "";

    const desc = (entry.description || entry.abstract || "").trim();

    results.push({
      name: entry.name || "",
      description: desc,
      primary_url: url,
      profile_url: entry.showUrl || `https://transiscope.gogocarto.fr`,
      latitude: lat,
      longitude: lng,
      locality,
      region: "",
      country,
      tags,
      source: "transiscope",
    });
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`  Saved to ${OUT_FILE}`);

  // Stats
  console.log("\n--- Stats ---");
  console.log(`API entries: ${data.length}`);
  console.log(`Skipped (no URL): ${skippedNoUrl}`);
  console.log(`Skipped (social media): ${skippedSocial}`);
  console.log(`Skipped (no coordinates): ${skippedNoCoords}`);
  console.log(`Skipped (duplicate domain): ${skippedDuplicate}`);
  console.log(`Final entries: ${results.length}`);

  // Country breakdown
  const countryCounts = {};
  for (const r of results) {
    const key = r.country || "(unknown)";
    countryCounts[key] = (countryCounts[key] || 0) + 1;
  }
  console.log("\nCountry breakdown:");
  for (const [country, count] of Object.entries(countryCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${country}: ${count}`);
  }

  // Tag breakdown
  const tagCounts = {};
  for (const r of results) {
    for (const t of r.tags) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }
  console.log("\nTag breakdown:");
  for (const [tag, count] of Object.entries(tagCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tag}: ${count}`);
  }

  // Source breakdown (top 10)
  const sourceCounts = {};
  for (const entry of data) {
    const key = entry.sourceKey || "(unknown)";
    sourceCounts[key] = (sourceCounts[key] || 0) + 1;
  }
  console.log("\nData source breakdown (top 10):");
  const topSources = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [src, count] of topSources) {
    console.log(`  ${src}: ${count}`);
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
