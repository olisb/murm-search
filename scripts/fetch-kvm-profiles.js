#!/usr/bin/env node

/**
 * Fetches Karte von Morgen (KVM) profiles from the Murmurations Index API
 * and enriches them with descriptions from individual profile URLs.
 *
 * KVM profiles use schema: karte_von_morgen-v1.0.0
 * The API caps results at 10,000 per query, so we use overlapping radial
 * geo-queries (lat/lon/range) to tile the world, then deduplicate.
 */

const fs = require("fs");
const path = require("path");

const INDEX_URL = "https://index.murmurations.network/v2/nodes";
const SCHEMA = "karte_von_morgen-v1.0.0";
const PAGE_SIZE = 30;
const CONCURRENCY = 10;
const DATA_DIR = path.join(__dirname, "..", "data");

const PLACEHOLDER_URLS = new Set(["-", "https://www.-/", "http://www.-/"]);

// Overlapping radial queries to cover the full dataset.
// Each must return <10,000 results. Overlaps are fine — we deduplicate by profile_url.
const GEO_QUERIES = [
  // Germany — split into regions to stay under 10k each
  { label: "North Germany (Hamburg)",   lat: 53.55, lon: 10.0,  range: "200km" },
  { label: "West Germany (Ruhr)",       lat: 51.5,  lon: 7.4,   range: "150km" },
  { label: "East Germany (Dresden)",    lat: 51.0,  lon: 13.7,  range: "200km" },
  { label: "South Germany (Munich)",    lat: 48.1,  lon: 11.6,  range: "200km" },
  { label: "Southwest Germany (Stuttgart)", lat: 48.8, lon: 9.2, range: "150km" },
  // Rest of Europe
  { label: "Switzerland/Austria",       lat: 47.0,  lon: 10.0,  range: "300km" },
  { label: "France",                    lat: 46.5,  lon: 2.5,   range: "600km" },
  { label: "UK/Ireland",               lat: 53.0,  lon: -2.0,  range: "600km" },
  { label: "Scandinavia",              lat: 60.0,  lon: 15.0,  range: "1000km" },
  { label: "Southern Europe",          lat: 40.0,  lon: 15.0,  range: "1500km" },
  { label: "Eastern Europe",           lat: 50.0,  lon: 25.0,  range: "1000km" },
  // Rest of world
  { label: "Americas",                 lat: 20.0,  lon: -80.0,  range: "8000km" },
  { label: "Africa/Middle East",       lat: 10.0,  lon: 30.0,   range: "6000km" },
  { label: "Asia/Pacific",             lat: 20.0,  lon: 100.0,  range: "8000km" },
];

async function fetchJSON(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = 1000 * attempt;
      console.warn(`  Retry ${attempt}/${retries} for ${url} (${err.message}), waiting ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function fetchNodesForQuery({ label, lat, lon, range }) {
  let page = 1;
  let nodes = [];
  let totalResults = null;

  console.log(`\n  [${label}] lat=${lat}, lon=${lon}, range=${range}`);

  while (true) {
    const url = `${INDEX_URL}?schema=${SCHEMA}&status=posted&page_size=${PAGE_SIZE}&lat=${lat}&lon=${lon}&range=${range}&page=${page}`;
    const json = await fetchJSON(url);

    if (!json.data || json.data.length === 0) break;

    nodes = nodes.concat(json.data);

    if (totalResults === null && json.meta?.number_of_results) {
      totalResults = json.meta.number_of_results;
      const pages = json.meta.total_pages || "?";
      console.log(`  [${label}] ${totalResults} results (${pages} pages)`);
      if (totalResults > 10000) {
        console.warn(`  [${label}] WARNING: >10k results, some will be missed!`);
      }
    }

    const pagesStr = totalResults ? `/${Math.ceil(Math.min(totalResults, 10000) / PAGE_SIZE)}` : "";
    process.stdout.write(`\r  [${label}] Page ${page}${pagesStr} — ${nodes.length} nodes`);

    if (!json.links?.next) break;
    page++;
  }

  console.log(`\n  [${label}] Done: ${nodes.length} nodes`);
  return nodes;
}

function extractProfile(node) {
  const geo = node.geolocation || {};
  const primaryUrl = node.primary_url && !PLACEHOLDER_URLS.has(node.primary_url)
    ? node.primary_url
    : null;

  return {
    profile_url: node.profile_url || null,
    name: node.name || null,
    description: null,
    latitude: geo.lat ?? null,
    longitude: geo.lon ?? null,
    locality: node.locality || null,
    region: node.region || null,
    country: node.country || null,
    tags: node.tags || [],
    primary_url: primaryUrl,
    source: "kvm",
  };
}

async function enrichProfile(profile) {
  if (!profile.profile_url) return profile;
  if (profile.name && profile.description) return profile;

  try {
    const full = await fetchJSON(profile.profile_url);
    if (!profile.name && full.name) profile.name = full.name;
    if (!profile.description && full.description) profile.description = full.description;
    if (full.country_name) profile.country = full.country_name;
    if (!profile.primary_url && full.primary_url && !PLACEHOLDER_URLS.has(full.primary_url)) {
      profile.primary_url = full.primary_url;
    }
  } catch (err) {
    // Silently skip — we still have index data
  }

  return profile;
}

async function enrichBatch(profiles, batchSize = CONCURRENCY) {
  const needsEnrichment = profiles.filter((p) => !p.name || !p.description);
  console.log(`\nEnriching ${needsEnrichment.length} profiles (missing name or description)...`);

  let done = 0;
  for (let i = 0; i < needsEnrichment.length; i += batchSize) {
    const batch = needsEnrichment.slice(i, i + batchSize);
    await Promise.all(batch.map(enrichProfile));
    done += batch.length;
    process.stdout.write(
      `\r  ${done}/${needsEnrichment.length} enriched (${((done / needsEnrichment.length) * 100).toFixed(1)}%)`
    );
  }
  console.log("\n");
}

async function main() {
  const startTime = Date.now();

  console.log("Fetching KVM nodes using geo-tiled queries...");
  console.log(`${GEO_QUERIES.length} queries planned\n`);

  // Fetch all geo queries
  const allNodes = [];
  for (const query of GEO_QUERIES) {
    const nodes = await fetchNodesForQuery(query);
    allNodes.push(...nodes);
  }

  console.log(`\nTotal nodes fetched (with overlaps): ${allNodes.length}`);

  // Deduplicate by profile_url
  const seen = new Map();
  for (const node of allNodes) {
    if (node.profile_url && !seen.has(node.profile_url)) {
      seen.set(node.profile_url, node);
    }
  }
  const uniqueNodes = [...seen.values()];
  console.log(`After deduplication: ${uniqueNodes.length} unique nodes (${allNodes.length - uniqueNodes.length} duplicates removed)\n`);

  // Extract and normalize
  const profiles = uniqueNodes.map(extractProfile);

  // Enrich
  await enrichBatch(profiles);

  // Filter
  const valid = profiles.filter((p) => p.name);
  console.log(`${valid.length} profiles with names (${profiles.length - valid.length} dropped).\n`);

  const withDesc = valid.filter((p) => p.description).length;
  const withGeo = valid.filter((p) => p.latitude != null && p.longitude != null).length;
  const withTags = valid.filter((p) => p.tags.length > 0).length;
  const withUrl = valid.filter((p) => p.primary_url).length;
  console.log(`  With description: ${withDesc}`);
  console.log(`  With geolocation: ${withGeo}`);
  console.log(`  With tags:        ${withTags}`);
  console.log(`  With website:     ${withUrl}`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, "kvm-profiles.json");
  fs.writeFileSync(outPath, JSON.stringify(valid, null, 2));
  console.log(`\nSaved ${valid.length} KVM profiles to ${outPath}`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
