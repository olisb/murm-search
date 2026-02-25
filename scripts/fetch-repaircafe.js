#!/usr/bin/env node

/**
 * Fetches and cleans repair cafe data from the official Repair Café API.
 * Source: https://www.repaircafe.org
 *
 * Cleaning steps:
 * - Skips entries without an external_link
 * - Skips entries where external_link is repaircafe.org (self-referential)
 * - Skips entries with social media URLs (facebook, instagram, twitter, x, youtube, tiktok, linkedin)
 * - Fixes URLs missing http/https prefix
 * - Deduplicates by domain
 * - Parses coordinate string "lat,lng" into separate numbers
 * - Extracts country from address (last comma-separated part)
 * - Extracts locality/city (second-to-last comma segment, stripping postal code)
 *
 * Usage:
 *   node scripts/fetch-repaircafe.js
 */

const fs = require("fs");
const path = require("path");

const API_URL = "https://www.repaircafe.org/wp-json/v1/map";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "repair-cafes.json");

const SKIP_DOMAINS = new Set([
  "facebook.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "tiktok.com", "linkedin.com",
]);

function isSkipDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    for (const skip of SKIP_DOMAINS) {
      if (host === skip || host.endsWith("." + skip)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isSelfReferential(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "repaircafe.org" || host.endsWith(".repaircafe.org");
  } catch {
    return false;
  }
}

function cleanUrl(raw) {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;

  // Fix URLs missing protocol
  if (!url.startsWith("http")) url = "https://" + url;

  // Skip self-referential links
  if (isSelfReferential(url)) return null;

  // Skip social media links
  if (isSkipDomain(url)) return null;

  return url;
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Parses coordinates string "lat,lng" into { lat, lon } numbers
 */
function parseCoordinates(coordStr) {
  if (!coordStr) return { lat: null, lon: null };
  const parts = coordStr.split(",").map(s => s.trim());
  if (parts.length !== 2) return { lat: null, lon: null };

  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);

  if (isNaN(lat) || isNaN(lon)) return { lat: null, lon: null };
  return { lat, lon };
}

/**
 * Parses address like "Street, Postal City, Country" into { locality, country }
 * The last segment is the country. The second-to-last is typically "postal city".
 */
function parseAddress(address) {
  if (!address) return { locality: "", country: "" };

  const parts = address.split(",").map(s => s.trim()).filter(Boolean);

  let locality = "";
  let country = "";

  // Last part is typically the country
  if (parts.length >= 1) {
    country = parts[parts.length - 1];
  }

  // Second-to-last is typically the city (may include postal code)
  if (parts.length >= 2) {
    let cityPart = parts[parts.length - 2];
    // Strip leading digits and spaces (postal code)
    locality = cityPart.replace(/^\d+\s*/, "").trim();
  }

  return { locality, country };
}

async function main() {
  console.log("Fetching Repair Café data...");

  const res = await fetch(API_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }

  const locations = await res.json();
  console.log(`  ${locations.length} entries received`);

  const profiles = [];
  const seenDomains = new Set();
  let skipped = {
    noUrl: 0,
    selfReferential: 0,
    socialMedia: 0,
    dupDomain: 0,
  };

  for (const loc of locations) {
    // Check for external_link
    const url = cleanUrl(loc.external_link);
    if (!url) {
      if (!loc.external_link) {
        skipped.noUrl++;
      } else if (isSelfReferential(loc.external_link)) {
        skipped.selfReferential++;
      } else {
        skipped.socialMedia++;
      }
      continue;
    }

    // Dedup by domain
    const domain = getDomain(url);
    if (!domain) continue;
    if (seenDomains.has(domain)) {
      skipped.dupDomain++;
      continue;
    }
    seenDomains.add(domain);

    // Parse coordinates
    const { lat, lon } = parseCoordinates(loc.coordinate);
    if (lat === null || lon === null) continue;

    // Parse address
    const { locality, country } = parseAddress(loc.address);

    profiles.push({
      name: (loc.name || "").trim(),
      description: "",
      primary_url: url,
      profile_url: (loc.link || "").trim(),
      latitude: lat,
      longitude: lon,
      locality,
      region: "",
      country,
      tags: ["repair cafe"],
      source: "repair-cafes",
    });
  }

  console.log(`\n--- Cleaning results ---`);
  console.log(`  Total received: ${locations.length}`);
  console.log(`  Kept: ${profiles.length}`);
  console.log(`  Skipped - no URL: ${skipped.noUrl}`);
  console.log(`  Skipped - self-referential (repaircafe.org): ${skipped.selfReferential}`);
  console.log(`  Skipped - social media URL: ${skipped.socialMedia}`);
  console.log(`  Skipped - duplicate domain: ${skipped.dupDomain}`);

  // Country breakdown (top 15)
  const countries = {};
  for (const p of profiles) {
    countries[p.country] = (countries[p.country] || 0) + 1;
  }
  console.log(`\n--- Countries (top 15) ---`);
  Object.entries(countries)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([c, n]) => console.log(`  ${c}: ${n}`));

  fs.writeFileSync(OUT_FILE, JSON.stringify(profiles, null, 2));
  console.log(`\nSaved to ${OUT_FILE}`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
