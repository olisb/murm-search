#!/usr/bin/env node

/**
 * Fetches and cleans ecovillage/community data from GEN Europe (Global Ecovillage Network).
 * Source: https://gen-europe.org/map
 *
 * Cleaning steps:
 * - Removes entries without a usable website URL (no Facebook, Instagram, directory links)
 * - Fixes country name typos
 * - Normalises network names into clean tags
 * - Strips HTML from descriptions, decodes entities
 * - Drops very short/empty descriptions
 * - Deduplicates by URL domain
 *
 * Usage:
 *   node scripts/fetch-gen-europe.js
 */

const fs = require("fs");
const path = require("path");

const API_URL = "https://gen-europe.org/wp-json/mapdata/v1/all?key=138Wk3qfsVNyrkUaG8i6oZaIRaoyUO5s";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "gen-europe.json");

// Domains that aren't real org websites (keeping Facebook/Instagram as some orgs only have those)
const SKIP_DOMAINS = new Set([
  "gen-europe.org", "ecovillage.org",
  "colibris-wiki.org", "sites.google.com",
  "hameaux-legers.org", "ecohabitons.org",
]);

// Country name fixes
const COUNTRY_FIXES = {
  "Netherland": "Netherlands",
  "Spain\n": "Spain",
  "Russia": "Russia",
};

// Network → clean tag mapping
const NETWORK_TAGS = {
  "cooperative oasis": "ecovillage",
  "habitat participatif": "ecovillage",
  "rive": "ecovillage",
  "gen": "ecovillage",
  "løs": "ecovillage",
  "rie": "ecovillage",
  "ero": "ecovillage",
  "seen": "ecovillage",
  "wise": "ecovillage",
  "skey": "ecovillage",
  "belgeco": "ecovillage",
  "reen": "ecovillage",
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
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

  // Fix common URL issues
  if (!url.startsWith("http")) url = "https://" + url;

  // Skip social media and directory links
  if (isSkipDomain(url)) return null;

  return url;
}

function getNetworkTag(network) {
  if (!network) return "ecovillage";
  const lower = network.toLowerCase();
  for (const [key, tag] of Object.entries(NETWORK_TAGS)) {
    if (lower.includes(key)) return tag;
  }
  return "ecovillage";
}

function fixCountry(country) {
  if (!country) return "";
  const trimmed = country.trim();
  return COUNTRY_FIXES[trimmed] || COUNTRY_FIXES[country] || trimmed;
}

async function main() {
  console.log("Fetching GEN Europe data...");

  const res = await fetch(API_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }

  const data = await res.json();
  const features = data.features || [];
  console.log(`  ${features.length} entries received`);

  const profiles = [];
  const seenDomains = new Set();
  let skipped = { noUrl: 0, socialMedia: 0, dupDomain: 0, noName: 0, noCoords: 0 };

  for (const f of features) {
    const p = f.properties || {};
    const coords = f.geometry?.coordinates || [];

    const name = (p.Name || "").trim();
    if (!name) { skipped.noName++; continue; }

    const lat = parseFloat(p.Latitude) || coords[1] || null;
    const lon = parseFloat(p.Longitude) || coords[0] || null;
    if (!lat || !lon) { skipped.noCoords++; continue; }

    const url = cleanUrl(p.URL);
    if (!url) {
      if ((p.URL || "").trim()) skipped.socialMedia++;
      else skipped.noUrl++;
      continue;
    }

    // Dedup by domain
    try {
      const domain = new URL(url).hostname.replace(/^www\./, "");
      if (seenDomains.has(domain)) { skipped.dupDomain++; continue; }
      seenDomains.add(domain);
    } catch {
      continue;
    }

    const description = decodeHtml(p.Description);
    const country = fixCountry(p.Country);
    const network = (p.Network || "").trim();
    const memberType = (p.MembershipType || "").trim();

    // Build tags
    const tags = ["ecovillage"];
    if (network.toLowerCase().includes("habitat participatif") || network.toLowerCase().includes("cooperative oasis")) {
      tags.push("cohousing");
    }
    if (memberType.toLowerCase().includes("ecovillage")) {
      // already tagged
    }

    profiles.push({
      name,
      description: description.length >= 15 ? description : "",
      primary_url: url,
      profile_url: url,
      latitude: lat,
      longitude: lon,
      locality: "",
      region: "",
      country,
      tags,
      source: "gen-europe",
    });
  }

  console.log(`\n--- Cleaning results ---`);
  console.log(`  Kept: ${profiles.length}`);
  console.log(`  Skipped - no URL: ${skipped.noUrl}`);
  console.log(`  Skipped - social media/directory URL: ${skipped.socialMedia}`);
  console.log(`  Skipped - duplicate domain: ${skipped.dupDomain}`);
  console.log(`  Skipped - no name: ${skipped.noName}`);
  console.log(`  Skipped - no coords: ${skipped.noCoords}`);

  const withDesc = profiles.filter(p => p.description).length;
  console.log(`\n--- Quality ---`);
  console.log(`  With description: ${withDesc}/${profiles.length} (${Math.round(100 * withDesc / profiles.length)}%)`);

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
