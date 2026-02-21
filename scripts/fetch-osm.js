#!/usr/bin/env node

/**
 * Fetches community spaces from OpenStreetMap via the Overpass API.
 * Supports multiple categories via CATEGORIES config.
 * URL validation and deduplication happen downstream (validate-urls.js, merge-profiles.js).
 *
 * Usage:
 *   node fetch-osm.js                  # fetch all categories
 *   node fetch-osm.js cooperatives     # fetch one category
 */

const fs = require("fs");
const path = require("path");

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const REGION_DELAY = 10000;
const DATA_DIR = path.join(__dirname, "..", "data");

const REGIONS = [
  { label: "Europe",             bbox: "(35,-25,72,45)" },
  { label: "Americas",           bbox: "(-60,-170,72,-30)" },
  { label: "Asia-Pacific",       bbox: "(-50,45,72,180)" },
  { label: "Africa/Middle East", bbox: "(-40,-25,40,65)" },
];

const CATEGORIES = [
  {
    name: "hackerspaces",
    tags: [
      { key: "leisure", value: "hackerspace" },
      { key: "amenity", value: "makerspace" },
    ],
    defaultTags: ["hackerspace"],
    outputFile: "osm-hackerspaces.json",
    tagLabel: (tags) => tags.amenity === "makerspace" ? "makerspace" : "hackerspace",
  },
  {
    name: "cooperatives",
    tags: [
      { key: "shop", value: "cooperative" },
      { key: "operator:type", value: "cooperative" },
      { key: "office", value: "cooperative" },
    ],
    defaultTags: ["cooperative", "coop"],
    outputFile: "osm-cooperatives.json",
  },
  {
    name: "repair_cafes",
    tags: [
      { key: "repair", value: "assisted_self_service" },
    ],
    defaultTags: ["repair cafe", "repair"],
    outputFile: "osm-repair_cafes.json",
  },
  {
    name: "coworking",
    tags: [
      { key: "amenity", value: "coworking_space" },
      { key: "office", value: "coworking" },
    ],
    defaultTags: ["coworking", "coworking space"],
    outputFile: "osm-coworking.json",
  },
  {
    name: "zero_waste",
    tags: [
      { key: "bulk_purchase", value: "yes" },
      { key: "zero_waste", value: "yes" },
      { key: "shop", value: "bulk" },
    ],
    defaultTags: ["zero waste", "bulk"],
    outputFile: "osm-zero_waste.json",
  },
  {
    name: "fair_trade",
    tags: [
      { key: "fair_trade", value: "yes" },
      { key: "fair_trade", value: "only" },
    ],
    defaultTags: ["fair trade"],
    outputFile: "osm-fair_trade.json",
  },
  {
    name: "ngos",
    tags: [
      { key: "office", value: "ngo" },
    ],
    defaultTags: ["ngo", "nonprofit"],
    outputFile: "osm-ngos.json",
  },
  {
    name: "charity_shops",
    tags: [
      { key: "shop", value: "charity" },
      { key: "shop", value: "second_hand" },
      { key: "amenity", value: "freeshop" },
    ],
    defaultTags: ["charity shop", "second hand"],
    outputFile: "osm-charity_shops.json",
    tagLabel: (tags) => {
      if (tags.amenity === "freeshop") return "free shop";
      if (tags.shop === "charity") return "charity shop";
      return "second hand shop";
    },
  },
  {
    name: "farm_shops",
    tags: [
      { key: "shop", value: "farm" },
    ],
    defaultTags: ["farm shop", "farm"],
    outputFile: "osm-farm_shops.json",
  },
  {
    name: "nature_reserves",
    tags: [
      { key: "leisure", value: "nature_reserve" },
    ],
    defaultTags: ["nature reserve", "conservation"],
    outputFile: "osm-nature_reserves.json",
  },
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

function buildQuery(bbox, category) {
  const bboxStr = bbox.replace(/[()]/g, "");
  const nwrs = category.tags
    .map((t) => `nwr["${t.key}"="${t.value}"]["website"~"."](${bboxStr});`)
    .join("");
  return `[out:json][timeout:120];\n(${nwrs});\nout center tags;`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function countryName(isoCode) {
  if (!isoCode) return null;
  const upper = isoCode.toUpperCase().trim();
  return COUNTRY_NAMES[upper] || isoCode;
}

function stripTrailingSlash(url) {
  return url && url.endsWith("/") ? url.slice(0, -1) : url;
}

function normalizeElement(el, category) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  const city = tags["addr:city"] || null;
  const countryCode = tags["addr:country"] || null;
  const fullCountry = countryName(countryCode);
  const name = tags.name || null;

  // Determine the label for this element
  const label = category.tagLabel
    ? category.tagLabel(tags)
    : category.name.replace(/s$/, ""); // e.g. "cooperatives" → "cooperative"

  let description = tags.description || null;
  if (!description && name) {
    const parts = [name, "is a", label];
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

  // Build tags array: use category defaults, override with tagLabel if available
  const profileTags = category.tagLabel
    ? [category.tagLabel(tags)]
    : [...category.defaultTags];

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
    tags: profileTags,
    primary_url: website,
    phone: tags.phone || tags["contact:phone"] || null,
    email: tags.email || tags["contact:email"] || null,
    opening_hours: tags.opening_hours || null,
    image: null,
  };
}

async function fetchRegion({ label, bbox }, category, retries = 3) {
  const query = buildQuery(bbox, category);

  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(`\n  [${label}] Querying Overpass API${attempt > 1 ? ` (retry ${attempt}/${retries})` : ""}...`);

    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (res.ok) {
      const json = await res.json();
      const elements = json.elements || [];
      console.log(`  [${label}] Received ${elements.length} elements`);
      return elements;
    }

    if (res.status === 504 || res.status === 429) {
      if (attempt < retries) {
        const wait = attempt * 15;
        console.log(`  [${label}] Got ${res.status}, waiting ${wait}s before retry...`);
        await sleep(wait * 1000);
        continue;
      }
    }

    // Final attempt failed — skip this region instead of crashing
    console.log(`  [${label}] Skipping after ${retries} failed attempts`);
    return [];
  }
}

async function fetchCategory(category) {
  console.log(`\n--- ${category.name} ---`);
  console.log(`OSM tags: ${category.tags.map((t) => `${t.key}=${t.value}`).join(", ")}`);
  console.log(`${REGIONS.length} regional queries planned`);

  const allElements = [];
  for (let i = 0; i < REGIONS.length; i++) {
    if (i > 0) {
      console.log(`\n  Waiting ${REGION_DELAY / 1000}s before next query...`);
      await sleep(REGION_DELAY);
    }
    const elements = await fetchRegion(REGIONS[i], category);
    allElements.push(...elements);
  }

  console.log(`\nTotal elements fetched (with potential overlaps): ${allElements.length}`);

  const profiles = allElements.map((el) => normalizeElement(el, category));

  // Deduplicate by OSM id (regions may overlap)
  const seen = new Map();
  for (const p of profiles) {
    if (!seen.has(p.profile_url)) {
      seen.set(p.profile_url, p);
    }
  }
  const unique = [...seen.values()];
  console.log(`After OSM dedup: ${unique.length} unique (${profiles.length - unique.length} overlaps removed)`);

  // Filter to profiles with a name and website
  const final = unique.filter((p) => p.name && p.primary_url);
  console.log(`${final.length} with name and website (${unique.length - final.length} dropped)`);

  // Save
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, category.outputFile);
  fs.writeFileSync(outPath, JSON.stringify(final, null, 2));
  console.log(`Saved ${final.length} profiles to ${outPath}`);

  return final;
}

async function main() {
  const startTime = Date.now();
  const requested = process.argv[2];

  const toFetch = requested
    ? CATEGORIES.filter((c) => c.name === requested)
    : CATEGORIES;

  if (toFetch.length === 0) {
    console.error(`Unknown category: "${requested}"`);
    console.error(`Available: ${CATEGORIES.map((c) => c.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`Fetching ${toFetch.length} OSM categor${toFetch.length === 1 ? "y" : "ies"} from Overpass API...`);

  let totalProfiles = 0;
  for (let i = 0; i < toFetch.length; i++) {
    if (i > 0) {
      const catDelay = REGION_DELAY * 3;
      console.log(`\nWaiting ${catDelay / 1000}s between categories...`);
      await sleep(catDelay);
    }
    const results = await fetchCategory(toFetch[i]);
    totalProfiles += results.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone: ${totalProfiles} total profiles across ${toFetch.length} categor${toFetch.length === 1 ? "y" : "ies"} in ${elapsed}s.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
