#!/usr/bin/env node

/**
 * Fetches and cleans food co-op data from the Grocery Story StorePoint API.
 * Source: https://grocerystory.coop
 *
 * Cleaning steps:
 * - Skips entries with social media URLs instead of real org websites
 * - Skips entries without coordinates
 * - Deduplicates by website domain
 * - Parses street address to extract city, state/region, and country
 * - Fixes URLs missing http/https prefix
 *
 * Usage:
 *   node scripts/fetch-grocery-coops.js
 */

const fs = require("fs");
const path = require("path");

const API_URL = "https://api.storepoint.co/v2/163800a1217c39/locations";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "grocery-coops.json");

const SKIP_DOMAINS = new Set([
  "facebook.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "tiktok.com", "linkedin.com",
]);

const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas",
  CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

const CA_PROVINCES = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba",
  NB: "New Brunswick", NL: "Newfoundland and Labrador",
  NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut",
  ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec",
  SK: "Saskatchewan", YT: "Yukon",
};

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

function cleanUrl(raw) {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;

  // Fix URLs missing protocol
  if (!url.startsWith("http")) url = "https://" + url;

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
 * Parses a street address like "1612 Sherman Blvd, Ft. Wayne, Indiana 46808"
 * into { locality, region, country }.
 */
function parseAddress(address) {
  if (!address) return { locality: "", region: "", country: "United States" };

  const parts = address.split(",").map(s => s.trim()).filter(Boolean);

  let locality = "";
  let region = "";
  let country = "United States";

  if (parts.length >= 2) {
    // Last part typically has "State ZIP" or "Province PostalCode"
    const lastPart = parts[parts.length - 1];
    // Second-to-last part is the city
    locality = parts[parts.length - 2];

    // Check if address explicitly mentions Canada
    if (/\bcanada\b/i.test(address)) {
      country = "Canada";
    }

    // Extract state/province abbreviation or full name from last segment
    // Format is usually "State ZIP" — strip the zip/postal code
    const stateZip = lastPart.replace(/\d{5}(-\d{4})?/, "").trim(); // US zip
    const statePostal = stateZip.replace(/[A-Z]\d[A-Z]\s*\d[A-Z]\d/i, "").trim(); // CA postal

    const abbrev = statePostal.toUpperCase().trim();

    if (CA_PROVINCES[abbrev]) {
      region = CA_PROVINCES[abbrev];
      country = "Canada";
    } else if (US_STATES[abbrev]) {
      region = US_STATES[abbrev];
    } else {
      // Maybe it's already a full state name (e.g., "Indiana")
      const fullNameMatch = Object.values(US_STATES).find(
        s => s.toLowerCase() === statePostal.toLowerCase()
      );
      if (fullNameMatch) {
        region = fullNameMatch;
      } else {
        const caMatch = Object.values(CA_PROVINCES).find(
          s => s.toLowerCase() === statePostal.toLowerCase()
        );
        if (caMatch) {
          region = caMatch;
          country = "Canada";
        } else {
          // Fallback: use the raw value
          region = statePostal;
        }
      }
    }
  }

  return { locality, region, country };
}

async function main() {
  console.log("Fetching Grocery Story co-op data...");

  const res = await fetch(API_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }

  const data = await res.json();
  const locations = (data.results && data.results.locations) || [];
  console.log(`  ${locations.length} entries received`);

  const profiles = [];
  const seenDomains = new Set();
  let skipped = { socialMedia: 0, noCoords: 0, dupDomain: 0, noUrl: 0 };

  for (const loc of locations) {
    const lat = parseFloat(loc.loc_lat);
    const lon = parseFloat(loc.loc_long);
    if (!lat || !lon) { skipped.noCoords++; continue; }

    const url = cleanUrl(loc.website);
    if (!url) {
      if ((loc.website || "").trim()) skipped.socialMedia++;
      else skipped.noUrl++;
      continue;
    }

    // Dedup by domain
    const domain = getDomain(url);
    if (!domain) continue;
    if (seenDomains.has(domain)) { skipped.dupDomain++; continue; }
    seenDomains.add(domain);

    const { locality, region, country } = parseAddress(loc.streetaddress);

    profiles.push({
      name: (loc.name || "").trim(),
      description: "",
      primary_url: url,
      profile_url: url,
      latitude: lat,
      longitude: lon,
      locality,
      region,
      country,
      tags: ["cooperative", "food cooperative"],
      source: "grocery-coops",
    });
  }

  console.log(`\n--- Cleaning results ---`);
  console.log(`  Total received: ${locations.length}`);
  console.log(`  Kept: ${profiles.length}`);
  console.log(`  Skipped - social media URL: ${skipped.socialMedia}`);
  console.log(`  Skipped - no coordinates: ${skipped.noCoords}`);
  console.log(`  Skipped - duplicate domain: ${skipped.dupDomain}`);
  console.log(`  Skipped - no URL: ${skipped.noUrl}`);

  // Country breakdown
  const countries = {};
  for (const p of profiles) {
    countries[p.country] = (countries[p.country] || 0) + 1;
  }
  console.log(`\n--- Countries ---`);
  Object.entries(countries)
    .sort((a, b) => b[1] - a[1])
    .forEach(([c, n]) => console.log(`  ${c}: ${n}`));

  fs.writeFileSync(OUT_FILE, JSON.stringify(profiles, null, 2));
  console.log(`\nSaved to ${OUT_FILE}`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
