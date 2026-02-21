#!/usr/bin/env node

/**
 * Fetches nature reserves from OSM via Overpass API.
 * Uses smaller bounding boxes and longer timeouts than fetch-osm.js
 * because nature reserves are large polygons that cause 504s on big regions.
 */

const fs = require("fs");
const path = require("path");

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DATA_DIR = path.join(__dirname, "..", "data");
const DELAY = 12000; // 12s between queries

// Smaller sub-regions to avoid 504 timeouts
const REGIONS = [
  // Europe - split into 4
  { label: "Europe-West",      bbox: "(35,-25,55,15)" },
  { label: "Europe-East",      bbox: "(35,15,55,45)" },
  { label: "Europe-North",     bbox: "(55,-25,72,45)" },
  { label: "Europe-South",     bbox: "(35,-10,46,30)" },
  // Americas - split into 4
  { label: "North America",    bbox: "(25,-170,72,-50)" },
  { label: "Central America",  bbox: "(5,-120,25,-60)" },
  { label: "South America-N",  bbox: "(-25,-85,5,-30)" },
  { label: "South America-S",  bbox: "(-60,-85,-25,-30)" },
  // Asia-Pacific - split into 4
  { label: "East Asia",        bbox: "(20,95,55,150)" },
  { label: "South-East Asia",  bbox: "(-15,95,20,155)" },
  { label: "South Asia",       bbox: "(5,60,40,95)" },
  { label: "Oceania",          bbox: "(-50,110,0,180)" },
  { label: "Central Asia",     bbox: "(35,45,55,95)" },
  // Africa/Middle East - split into 3
  { label: "North Africa/ME",  bbox: "(15,-20,40,65)" },
  { label: "West/Central Africa", bbox: "(-10,-20,15,30)" },
  { label: "East/South Africa", bbox: "(-40,15,15,55)" },
];

const COUNTRY_NAMES = {
  AF: "Afghanistan", AL: "Albania", DZ: "Algeria", AR: "Argentina", AM: "Armenia",
  AU: "Australia", AT: "Austria", AZ: "Azerbaijan", BD: "Bangladesh", BY: "Belarus",
  BE: "Belgium", BA: "Bosnia and Herzegovina", BR: "Brazil", BG: "Bulgaria",
  CA: "Canada", CL: "Chile", CN: "China", CO: "Colombia", HR: "Croatia",
  CZ: "Czech Republic", DK: "Denmark", EC: "Ecuador", EG: "Egypt", EE: "Estonia",
  FI: "Finland", FR: "France", GE: "Georgia", DE: "Germany", GH: "Ghana",
  GR: "Greece", HU: "Hungary", IS: "Iceland", IN: "India", ID: "Indonesia",
  IR: "Iran", IQ: "Iraq", IE: "Ireland", IL: "Israel", IT: "Italy",
  JP: "Japan", JO: "Jordan", KZ: "Kazakhstan", KE: "Kenya", KR: "South Korea",
  LV: "Latvia", LB: "Lebanon", LT: "Lithuania", LU: "Luxembourg", MY: "Malaysia",
  MX: "Mexico", MA: "Morocco", NL: "Netherlands", NZ: "New Zealand", NG: "Nigeria",
  NO: "Norway", PK: "Pakistan", PE: "Peru", PH: "Philippines", PL: "Poland",
  PT: "Portugal", RO: "Romania", RU: "Russia", SA: "Saudi Arabia", RS: "Serbia",
  SG: "Singapore", SK: "Slovakia", SI: "Slovenia", ZA: "South Africa", ES: "Spain",
  SE: "Sweden", CH: "Switzerland", TW: "Taiwan", TH: "Thailand", TN: "Tunisia",
  TR: "Turkey", UA: "Ukraine", AE: "United Arab Emirates", GB: "United Kingdom",
  US: "United States", UY: "Uruguay", VE: "Venezuela", VN: "Vietnam",
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function countryName(c) { return c ? (COUNTRY_NAMES[c.toUpperCase().trim()] || c) : null; }
function stripSlash(u) { return u && u.endsWith("/") ? u.slice(0, -1) : u; }

function buildQuery(bbox) {
  const b = bbox.replace(/[()]/g, "");
  return `[out:json][timeout:300];\n(nwr["leisure"="nature_reserve"]["website"~"."](${b}););\nout center tags;`;
}

function normalize(el) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  const city = tags["addr:city"] || null;
  const cc = tags["addr:country"] || null;
  const country = countryName(cc);
  const name = tags.name || null;

  let description = tags.description || null;
  if (!description && name) {
    const parts = [name, "is a nature reserve"];
    if (city || country) {
      parts.push("in");
      const loc = [];
      if (city) loc.push(city);
      if (country) loc.push(country);
      parts.push(loc.join(", "));
    }
    description = parts.join(" ");
  }

  const website = tags.website ? stripSlash(tags.website.trim()) : null;

  return {
    profile_url: `osm:${el.type}/${el.id}`,
    source: "openstreetmap",
    name,
    description,
    latitude: lat,
    longitude: lon,
    locality: city,
    region: tags["addr:state"] || tags["addr:county"] || null,
    country,
    tags: ["nature reserve", "conservation"],
    primary_url: website,
    phone: tags.phone || tags["contact:phone"] || null,
    email: tags.email || tags["contact:email"] || null,
    opening_hours: tags.opening_hours || null,
    image: null,
  };
}

async function fetchRegion({ label, bbox }, retries = 3) {
  const query = buildQuery(bbox);
  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(`  [${label}] Querying${attempt > 1 ? ` (retry ${attempt})` : ""}...`);
    try {
      const res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (res.ok) {
        const json = await res.json();
        const els = json.elements || [];
        console.log(`  [${label}] ${els.length} elements`);
        return els;
      }
      if ((res.status === 504 || res.status === 429) && attempt < retries) {
        const wait = attempt * 20;
        console.log(`  [${label}] ${res.status}, waiting ${wait}s...`);
        await sleep(wait * 1000);
        continue;
      }
    } catch (err) {
      if (attempt < retries) {
        console.log(`  [${label}] Error: ${err.message}, retrying in 20s...`);
        await sleep(20000);
        continue;
      }
    }
    console.log(`  [${label}] Skipping after ${retries} attempts`);
    return [];
  }
}

async function main() {
  const start = Date.now();
  console.log(`Fetching nature reserves from ${REGIONS.length} sub-regions...\n`);

  const allElements = [];
  for (let i = 0; i < REGIONS.length; i++) {
    if (i > 0) {
      console.log(`  (waiting ${DELAY/1000}s)\n`);
      await sleep(DELAY);
    }
    const els = await fetchRegion(REGIONS[i]);
    allElements.push(...els);
  }

  console.log(`\nTotal raw elements: ${allElements.length}`);

  const profiles = allElements.map(normalize);

  // Deduplicate by OSM id
  const seen = new Map();
  for (const p of profiles) {
    if (!seen.has(p.profile_url)) seen.set(p.profile_url, p);
  }
  const unique = [...seen.values()];
  console.log(`After dedup: ${unique.length} (${profiles.length - unique.length} overlaps)`);

  const final = unique.filter(p => p.name && p.primary_url);
  console.log(`With name + website: ${final.length}`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, "osm-nature_reserves.json");
  fs.writeFileSync(outPath, JSON.stringify(final, null, 2));
  console.log(`Saved to ${outPath}`);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
