#!/usr/bin/env node

/**
 * Fetches all organisation profiles from the Murmurations Index API
 * and enriches them with descriptions from individual profile URLs.
 */

const fs = require("fs");
const path = require("path");

const INDEX_URL = "https://index.murmurations.network/v2/nodes";
const SCHEMA = "organizations_schema-v1.0.0";
const PAGE_SIZE = 30; // API max
const CONCURRENCY = 10; // parallel profile fetches
const DATA_DIR = path.join(__dirname, "..", "data");

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

async function fetchAllNodes() {
  let page = 1;
  let allNodes = [];
  let totalPages = null;

  console.log("Fetching nodes from Murmurations Index...");
  console.log(`Schema: ${SCHEMA}, page_size: ${PAGE_SIZE}\n`);

  while (true) {
    const url = `${INDEX_URL}?schema=${SCHEMA}&page_size=${PAGE_SIZE}&page=${page}`;
    const json = await fetchJSON(url);

    if (!json.data || json.data.length === 0) break;

    allNodes = allNodes.concat(json.data);

    // Extract total pages from last link on first request
    if (totalPages === null && json.links?.last) {
      const match = json.links.last.match(/page=(\d+)/);
      if (match) totalPages = parseInt(match[1]);
    }

    const pagesStr = totalPages ? `/${totalPages}` : "";
    process.stdout.write(`\r  Page ${page}${pagesStr} — ${allNodes.length} nodes so far`);

    if (!json.links?.next) break;
    page++;
  }

  console.log(`\n\nFetched ${allNodes.length} nodes from index.\n`);
  return allNodes;
}

function extractProfile(node) {
  const geo = node.geolocation || {};
  return {
    profile_url: node.profile_url || null,
    name: node.name || null,
    description: null, // not in index response
    latitude: geo.lat ?? null,
    longitude: geo.lon ?? null,
    locality: node.locality || null,
    region: node.region || null,
    country: node.country || node.country_name || null,
    tags: node.tags || [],
    primary_url: node.primary_url && node.primary_url !== "-" ? node.primary_url : null,
    image: null,
    source: "murmurations",
  };
}

async function enrichProfile(profile) {
  if (!profile.profile_url) return profile;
  // Only fetch full profile if missing name or description
  if (profile.name && profile.description) return profile;

  try {
    const full = await fetchJSON(profile.profile_url);
    if (!profile.name && full.name) profile.name = full.name;
    if (!profile.description && full.description) profile.description = full.description;
    if (full.image) profile.image = full.image;
    // Pick up country_name if we only had country code
    if (full.country_name) profile.country = full.country_name;
  } catch (err) {
    // Silently skip — we still have index data
  }

  return profile;
}

async function enrichBatch(profiles, batchSize = CONCURRENCY) {
  const needsEnrichment = profiles.filter((p) => !p.name || !p.description);
  console.log(`Enriching ${needsEnrichment.length} profiles (missing name or description)...`);

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

  // Fetch all nodes from index
  const nodes = await fetchAllNodes();

  // Extract and normalize profiles
  const profiles = nodes.map(extractProfile);

  // Enrich with full profile data where needed
  await enrichBatch(profiles);

  // Filter out profiles without a name
  const valid = profiles.filter((p) => p.name);
  console.log(`${valid.length} profiles with names (${profiles.length - valid.length} dropped).\n`);

  // Summary stats
  const withDesc = valid.filter((p) => p.description).length;
  const withGeo = valid.filter((p) => p.latitude != null && p.longitude != null).length;
  const withTags = valid.filter((p) => p.tags.length > 0).length;
  console.log(`  With description: ${withDesc}`);
  console.log(`  With geolocation: ${withGeo}`);
  console.log(`  With tags:        ${withTags}`);

  // Save
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, "profiles.json");
  fs.writeFileSync(outPath, JSON.stringify(valid, null, 2));
  console.log(`\nSaved ${valid.length} profiles to ${outPath}`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
