#!/usr/bin/env node

/**
 * Geocodes profiles in profiles.json that have city/region/country but no lat/lon.
 * Uses Nominatim (1 req/sec rate limit).
 *
 * Usage:
 *   node scripts/geocode-missing.js [--source ic-directory]
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");

const sourceFilter = process.argv[2] === "--source" ? process.argv[3] : null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocode(locality, region, country) {
  const parts = [locality, region, country].filter(Boolean);
  if (parts.length === 0) return null;
  const query = parts.join(", ");
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "CoBot/1.0 (community directory)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.length > 0) {
      return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    }
    // Fallback: try without locality
    if (locality && region) {
      await sleep(1100);
      const fallbackQuery = [region, country].filter(Boolean).join(", ");
      const res2 = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(fallbackQuery)}&format=json&limit=1`,
        { headers: { "User-Agent": "CoBot/1.0 (community directory)" }, signal: AbortSignal.timeout(10000) }
      );
      if (res2.ok) {
        const data2 = await res2.json();
        if (data2.length > 0) {
          return { lat: parseFloat(data2[0].lat), lon: parseFloat(data2[0].lon) };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function main() {
  const profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));

  const needGeo = [];
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    if (p.latitude && p.longitude) continue;
    if (sourceFilter && p.source !== sourceFilter) continue;
    if (!p.locality && !p.region && !p.country) continue;
    needGeo.push(i);
  }

  console.log(`${needGeo.length} profiles need geocoding${sourceFilter ? ` (source: ${sourceFilter})` : ""}`);

  let geocoded = 0;
  let failed = 0;

  for (let j = 0; j < needGeo.length; j++) {
    const i = needGeo[j];
    const p = profiles[i];

    const result = await geocode(p.locality, p.region, p.country);
    if (result) {
      profiles[i].latitude = result.lat;
      profiles[i].longitude = result.lon;
      geocoded++;
    } else {
      failed++;
    }

    if ((j + 1) % 50 === 0 || j === needGeo.length - 1) {
      console.log(`  ${j + 1}/${needGeo.length} (${geocoded} geocoded, ${failed} failed)`);
    }

    // Nominatim rate limit: 1 req/sec
    await sleep(1100);
  }

  console.log(`\nDone: ${geocoded} geocoded, ${failed} failed`);

  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
  console.log(`Updated ${PROFILES_FILE}`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
