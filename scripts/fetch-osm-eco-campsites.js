#!/usr/bin/env node

/**
 * Fetches eco campsites from OpenStreetMap via Overpass API.
 * Runs sub-queries individually to avoid timeout, then merges/deduplicates.
 * Expected count: ~2,030.
 */

const fs = require("fs");
const path = require("path");

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DATA_DIR = path.join(__dirname, "..", "data");
const QUERY_DELAY = 15000;

// Each sub-query targets a specific eco signal
const SUB_QUERIES = [
  { label: "name regex (eco/green/nature)", query: `[out:json][timeout:120];nwr["tourism"="camp_site"]["website"~"."]["name"~"[Ee]co|[Öö]ko|[Gg]reen|[Gg]rün|[Nn]atur"];out center tags;` },
  { label: "name regex (organic/bio/farm)", query: `[out:json][timeout:120];nwr["tourism"="camp_site"]["website"~"."]["name"~"[Oo]rganic|[Bb]io[^a-z]|[Ff]arm"];out center tags;` },
  { label: "name regex (permaculture/sustain/durable/wild)", query: `[out:json][timeout:120];nwr["tourism"="camp_site"]["website"~"."]["name"~"[Pp]ermaculture|[Pp]ermakultur|[Ss]ustain|[Dd]urable|[Ww]ild"];out center tags;` },
  { label: "organic=yes", query: `[out:json][timeout:120];nwr["tourism"="camp_site"]["website"~"."]["organic"="yes"];out center tags;` },
  { label: "operator:type (community/cooperative/ngo)", query: `[out:json][timeout:120];nwr["tourism"="camp_site"]["website"~"."]["operator:type"~"community|cooperative|ngo|association|charity|non_profit"];out center tags;` },
  { label: "description regex", query: `[out:json][timeout:120];nwr["tourism"="camp_site"]["website"~"."]["description"~"[Ee]co|[Ss]ustain|[Oo]rganic|[Pp]ermaculture|[Rr]egenerat"];out center tags;` },
  { label: "scout=yes", query: `[out:json][timeout:120];nwr["tourism"="camp_site"]["website"~"."]["scout"="yes"];out center tags;` },
  { label: "group_only=yes", query: `[out:json][timeout:120];nwr["tourism"="camp_site"]["website"~"."]["group_only"="yes"];out center tags;` },
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

function countryName(isoCode) {
  if (!isoCode) return null;
  return COUNTRY_NAMES[isoCode.toUpperCase().trim()] || isoCode;
}

function stripTrailingSlash(url) {
  return url && url.endsWith("/") ? url.slice(0, -1) : url;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeElement(el) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  const city = tags["addr:city"] || null;
  const countryCode = tags["addr:country"] || null;
  const fullCountry = countryName(countryCode);
  const name = tags.name || null;

  let description = tags.description || null;
  if (!description && name) {
    const parts = [name, "is an eco campsite"];
    if (city || fullCountry) {
      parts.push("in");
      const locationParts = [];
      if (city) locationParts.push(city);
      if (fullCountry) locationParts.push(fullCountry);
      parts.push(locationParts.join(", "));
    }
    description = parts.join(" ");
  }

  const website = tags.website ? stripTrailingSlash(tags.website.trim()) : null;

  return {
    profile_url: `osm:${el.type}/${el.id}`,
    source: "openstreetmap",
    name,
    description,
    latitude: lat,
    longitude: lon,
    locality: city,
    region: tags["addr:state"] || tags["addr:county"] || null,
    country: fullCountry,
    tags: ["eco campsite", "nature", "sustainable tourism"],
    primary_url: website,
    phone: tags.phone || tags["contact:phone"] || null,
    email: tags.email || tags["contact:email"] || null,
    opening_hours: tags.opening_hours || null,
    image: null,
  };
}

async function fetchSubQuery(sq, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(`  [${sq.label}] Querying${attempt > 1 ? ` (retry ${attempt}/${retries})` : ""}...`);
    try {
      const res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(sq.query)}`,
      });

      if (res.ok) {
        const json = await res.json();
        if (json.remark && json.remark.includes("timed out")) {
          console.log(`  [${sq.label}] Query timed out`);
          if (attempt < retries) { await sleep(attempt * 15000); continue; }
          return [];
        }
        const elements = json.elements || [];
        console.log(`  [${sq.label}] ${elements.length} elements`);
        return elements;
      }

      if (res.status === 504 || res.status === 429) {
        if (attempt < retries) {
          const wait = attempt * 15;
          console.log(`  [${sq.label}] Got ${res.status}, waiting ${wait}s...`);
          await sleep(wait * 1000);
          continue;
        }
      }
    } catch (err) {
      console.log(`  [${sq.label}] Network error: ${err.cause?.code || err.message}`);
      if (attempt < retries) {
        const wait = attempt * 20;
        console.log(`  [${sq.label}] Waiting ${wait}s before retry...`);
        await sleep(wait * 1000);
        continue;
      }
    }
    console.log(`  [${sq.label}] Skipping after ${retries} failed attempts`);
    return [];
  }
}

async function main() {
  const startTime = Date.now();
  console.log(`Fetching eco campsites (${SUB_QUERIES.length} sub-queries)...\n`);

  const allElements = [];
  for (let i = 0; i < SUB_QUERIES.length; i++) {
    if (i > 0) await sleep(QUERY_DELAY);
    const elements = await fetchSubQuery(SUB_QUERIES[i]);
    allElements.push(...elements);
  }

  console.log(`\nTotal elements fetched (with overlaps): ${allElements.length}`);

  const profiles = allElements.map(el => normalizeElement(el));

  // Deduplicate by OSM id
  const seen = new Map();
  for (const p of profiles) {
    if (!seen.has(p.profile_url)) seen.set(p.profile_url, p);
  }
  const unique = [...seen.values()];
  console.log(`After dedup: ${unique.length} unique (${profiles.length - unique.length} overlaps removed)`);

  const final = unique.filter(p => p.name && p.primary_url);
  console.log(`${final.length} with name and website (${unique.length - final.length} dropped)`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, "osm-eco_campsites.json");
  fs.writeFileSync(outPath, JSON.stringify(final, null, 2));
  console.log(`Saved ${final.length} profiles to ${outPath}`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s.`);
}

main().catch(err => { console.error("Fatal error:", err); process.exit(1); });
