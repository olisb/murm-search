#!/usr/bin/env node

/**
 * Fetches and cleans intentional community data from ic.org directory API.
 * Source: https://www.ic.org/directory/
 *
 * Phase 1: Paginate through listing endpoint to collect all slugs
 * Phase 2: Fetch full entry details for each slug (concurrency 3)
 * Phase 3: Clean and output to data/ic-directory.json
 *
 * Cleaning steps:
 * - Removes entries without a usable website URL (no social media links)
 * - Skips disbanded communities
 * - Fixes URLs missing protocol
 * - Deduplicates by domain
 * - Strips HTML from descriptions, decodes entities
 * - Truncates descriptions to 500 chars
 *
 * Usage:
 *   node scripts/fetch-ic.js
 */

const fs = require("fs");
const path = require("path");

const LISTING_URL = "https://www.ic.org/wp-json/v1/directory/entries/";
const ENTRY_URL = "https://www.ic.org/wp-json/v1/directory/entry/";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "ic-directory.json");
const CONCURRENCY = 3;
const DELAY_BETWEEN_BATCHES = 200;
const PER_PAGE = 25;

const SOCIAL_DOMAINS = new Set([
  "facebook.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "tiktok.com", "linkedin.com", "meetup.com",
]);

// communityTypes → tag mapping
const TYPE_TAG_MAP = {
  "ecovillage": "ecovillage",
  "cohousing": "cohousing",
  "commune": "commune",
  "shared housing": "cohousing",
  "coliving": "cohousing",
  "spiritual": "intentional community",
  "student": "cooperative",
  "transition town": "ecovillage",
  "indigenous": "intentional community",
};

function decodeHtml(str) {
  if (!str) return "";
  return str
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&mdash;/g, "\u2014")
    .replace(/\s+/g, " ")
    .trim();
}

function isSocialDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    for (const skip of SOCIAL_DOMAINS) {
      if (host === skip || host.endsWith("." + skip)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function cleanUrl(raw) {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;
  if (!url.startsWith("http")) url = "https://" + url;
  if (isSocialDomain(url)) return null;
  // Validate
  try {
    new URL(url);
  } catch {
    return null;
  }
  return url;
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function mapTags(communityTypes) {
  const tags = new Set(["intentional community"]);
  if (!communityTypes) return [...tags];

  const types = Array.isArray(communityTypes) ? communityTypes : [communityTypes];
  for (const t of types) {
    if (!t) continue;
    const lower = t.toLowerCase().trim();
    for (const [key, tag] of Object.entries(TYPE_TAG_MAP)) {
      if (lower.includes(key)) {
        tags.add(tag);
      }
    }
  }
  return [...tags];
}

function extractCoords(entry) {
  // Check various possible field names for coordinates
  const latFields = ["latitude", "lat", "Latitude", "Lat"];
  const lonFields = ["longitude", "lng", "lon", "Longitude", "Lng", "Lon"];

  let latitude = null;
  let longitude = null;

  for (const f of latFields) {
    if (entry[f] != null && entry[f] !== "") {
      const val = parseFloat(entry[f]);
      if (!isNaN(val) && val !== 0) { latitude = val; break; }
    }
  }
  for (const f of lonFields) {
    if (entry[f] != null && entry[f] !== "") {
      const val = parseFloat(entry[f]);
      if (!isNaN(val) && val !== 0) { longitude = val; break; }
    }
  }

  // Also check nested location/geo objects
  if (latitude === null && entry.location) {
    const loc = entry.location;
    if (loc.latitude) latitude = parseFloat(loc.latitude) || null;
    if (loc.longitude) longitude = parseFloat(loc.longitude) || null;
    if (loc.lat) latitude = parseFloat(loc.lat) || null;
    if (loc.lng) longitude = parseFloat(loc.lng) || null;
  }
  if (latitude === null && entry.geo) {
    const geo = entry.geo;
    if (geo.latitude) latitude = parseFloat(geo.latitude) || null;
    if (geo.longitude) longitude = parseFloat(geo.longitude) || null;
    if (geo.lat) latitude = parseFloat(geo.lat) || null;
    if (geo.lng) longitude = parseFloat(geo.lng) || null;
  }

  return { latitude, longitude };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const res = await fetch(url, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

async function fetchAllListings() {
  console.log("Phase 1: Fetching all listings...");
  const allListings = [];
  let page = 1;
  let totalCount = null;

  while (true) {
    const url = `${LISTING_URL}?page=${page}`;
    const data = await fetchJson(url);

    if (totalCount === null) {
      totalCount = data.totalCount || 0;
      console.log(`  Total count reported: ${totalCount}`);
    }

    const listings = data.listings || [];
    if (listings.length === 0) break;

    allListings.push(...listings);
    process.stdout.write(`\r  Page ${page}: ${allListings.length} listings collected`);

    if (listings.length < PER_PAGE || allListings.length >= totalCount) break;
    page++;
  }
  console.log();
  console.log(`  ${allListings.length} total listings found`);
  return allListings;
}

async function fetchEntryDetails(slug) {
  try {
    const url = `${ENTRY_URL}?slug=${encodeURIComponent(slug)}`;
    return await fetchJson(url);
  } catch (err) {
    return null;
  }
}

async function fetchAllEntries(listings) {
  console.log(`\nPhase 2: Fetching entry details (concurrency ${CONCURRENCY})...`);
  const entries = [];
  let fetched = 0;
  let failed = 0;

  for (let i = 0; i < listings.length; i += CONCURRENCY) {
    const batch = listings.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(listing => fetchEntryDetails(listing.slug))
    );

    for (const entry of results) {
      if (entry) {
        entries.push(entry);
      } else {
        failed++;
      }
    }

    fetched = Math.min(i + CONCURRENCY, listings.length);
    if (fetched % 50 === 0 || fetched === listings.length) {
      console.log(`  ${fetched}/${listings.length} fetched (${entries.length} ok, ${failed} failed)`);
    }

    if (i + CONCURRENCY < listings.length) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
    }
  }

  console.log(`  ${entries.length} entries fetched successfully`);
  return entries;
}

function cleanEntries(entries) {
  console.log("\nPhase 3: Cleaning and outputting...");

  const profiles = [];
  const seenDomains = new Set();
  const skipped = { noUrl: 0, socialMedia: 0, disbanded: 0, dupDomain: 0 };
  const typeCounts = {};

  for (const entry of entries) {
    // Track community types
    const types = Array.isArray(entry.communityTypes)
      ? entry.communityTypes
      : entry.communityTypes ? [entry.communityTypes] : [];
    for (const t of types) {
      const name = (typeof t === "string" ? t : t.name || t.label || String(t)).trim();
      if (name) typeCounts[name] = (typeCounts[name] || 0) + 1;
    }

    // Skip disbanded
    const status = (typeof entry.communityStatus === "string"
      ? entry.communityStatus
      : (entry.communityStatus?.label || entry.communityStatus?.name || "")).toLowerCase();
    if (status.includes("disbanded")) {
      skipped.disbanded++;
      continue;
    }

    // Check website URL
    const rawUrl = entry.websiteUrl || entry.website_url || entry.website || "";
    const url = cleanUrl(rawUrl);
    if (!url) {
      if (rawUrl.trim() && isSocialDomain(rawUrl.trim().startsWith("http") ? rawUrl.trim() : "https://" + rawUrl.trim())) {
        skipped.socialMedia++;
      } else {
        skipped.noUrl++;
      }
      continue;
    }

    // Deduplicate by domain
    const domain = getDomain(url);
    if (domain && seenDomains.has(domain)) {
      skipped.dupDomain++;
      continue;
    }
    if (domain) seenDomains.add(domain);

    // Clean description
    const rawDesc = decodeHtml(entry.description || "");
    const rawMission = decodeHtml(entry.missionStatement || entry.mission_statement || "");
    let description = rawDesc || rawMission;
    if (description.length > 500) {
      description = description.slice(0, 497) + "...";
    }

    // Extract coordinates
    const { latitude, longitude } = extractCoords(entry);

    // Build slug for profile URL
    const slug = entry.slug || "";
    const profileUrl = slug ? `https://www.ic.org/directory/${slug}/` : "";

    // Map tags
    const typeNames = types.map(t => typeof t === "string" ? t : t.name || t.label || String(t));
    const tags = mapTags(typeNames);

    const name = (entry.name || "").trim();
    if (!name) continue;

    profiles.push({
      name,
      description,
      primary_url: url,
      profile_url: profileUrl,
      latitude,
      longitude,
      locality: (entry.city || "").trim(),
      region: (entry.state || "").trim(),
      country: (entry.country || "").trim(),
      tags,
      source: "ic-directory",
    });
  }

  return { profiles, skipped, typeCounts };
}

function printStats(entries, profiles, skipped, typeCounts) {
  console.log(`\n--- Results ---`);
  console.log(`  Total listings found: ${entries.length}`);
  console.log(`  Kept: ${profiles.length}`);
  console.log(`  Skipped - no URL: ${skipped.noUrl}`);
  console.log(`  Skipped - social media URL: ${skipped.socialMedia}`);
  console.log(`  Skipped - disbanded: ${skipped.disbanded}`);
  console.log(`  Skipped - duplicate domain: ${skipped.dupDomain}`);

  const withCoords = profiles.filter(p => p.latitude !== null).length;
  const withDesc = profiles.filter(p => p.description).length;
  console.log(`\n--- Quality ---`);
  console.log(`  With coordinates: ${withCoords}/${profiles.length} (${Math.round(100 * withCoords / profiles.length)}%)`);
  console.log(`  With description: ${withDesc}/${profiles.length} (${Math.round(100 * withDesc / profiles.length)}%)`);

  // Country breakdown (top 15)
  const countries = {};
  for (const p of profiles) {
    const c = p.country || "(unknown)";
    countries[c] = (countries[c] || 0) + 1;
  }
  console.log(`\n--- Countries (top 15) ---`);
  Object.entries(countries)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([c, n]) => console.log(`  ${c}: ${n}`));

  // Community type breakdown
  console.log(`\n--- Community Types ---`);
  Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`  ${t}: ${n}`));
}

async function main() {
  console.log("Fetching ic.org directory data...\n");

  // Phase 1
  const listings = await fetchAllListings();

  // Phase 2
  const entries = await fetchAllEntries(listings);

  // Phase 3
  const { profiles, skipped, typeCounts } = cleanEntries(entries);

  printStats(entries, profiles, skipped, typeCounts);

  // Ensure data dir exists
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  fs.writeFileSync(OUT_FILE, JSON.stringify(profiles, null, 2));
  console.log(`\nSaved ${profiles.length} entries to ${OUT_FILE}`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
