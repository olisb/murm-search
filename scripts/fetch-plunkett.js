#!/usr/bin/env node

/**
 * Fetches community business data from Plunkett Foundation's Community Business Map.
 * Source: https://plunkett.co.uk/community-business-map/
 *
 * The map page embeds a `places` array in a WP Google Map Gold plugin initialization.
 * Each place has: title, address, lat/lng, category, and extra_fields (website, etc.).
 *
 * Usage:
 *   node scripts/fetch-plunkett.js
 */

const fs = require("fs");
const path = require("path");

const PAGE_URL = "https://plunkett.co.uk/community-business-map/";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "plunkett.json");
const FETCH_TIMEOUT = 30000;

const SKIP_DOMAINS = new Set([
  "facebook.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "tiktok.com", "linkedin.com",
]);

function isSkipUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return SKIP_DOMAINS.has(host) || SKIP_DOMAINS.has(host.split(".").slice(-2).join("."));
  } catch {
    return true;
  }
}

function fixUrl(url) {
  if (!url) return "";
  url = url.trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    new URL(url);
    return url;
  } catch {
    return "";
  }
}

/**
 * Extract URL from an HTML anchor tag like:
 *   <a href=" http://www.4cg.cymru/" target="_blank">Online</a>
 */
function extractUrlFromHtml(html) {
  if (!html) return "";
  const match = html.match(/href\s*=\s*["']\s*(https?:\/\/[^"'\s]+)\s*["']/i);
  if (match) return match[1].trim();
  // Maybe it's just a bare URL
  const bareMatch = html.match(/(https?:\/\/[^\s<>"]+)/i);
  if (bareMatch) return bareMatch[1].trim();
  return "";
}

async function main() {
  console.log("Fetching Plunkett Community Business Map page...");
  const res = await fetch(PAGE_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }
  const html = await res.text();
  console.log(`  Page fetched (${(html.length / 1024).toFixed(0)} KB)`);

  // Extract the places array from the embedded JavaScript
  // The data sits inside: .maps({"map_options":{...},"places":[...],"marker_cluster":{...}})
  // We find the start of the array and then bracket-match to find the end.
  const startMarker = '"places":';
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) {
    console.error("Could not find places array in page HTML");
    process.exit(1);
  }

  const arrayStart = html.indexOf("[", startIdx);
  if (arrayStart === -1) {
    console.error("Could not find opening bracket for places array");
    process.exit(1);
  }

  // Bracket-match to find the end of the array
  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < html.length; i++) {
    if (html[i] === "[") depth++;
    else if (html[i] === "]") depth--;
    if (depth === 0) { arrayEnd = i; break; }
  }
  if (arrayEnd === -1) {
    console.error("Could not find closing bracket for places array");
    process.exit(1);
  }

  const placesJson = html.slice(arrayStart, arrayEnd + 1);
  let places;
  try {
    places = JSON.parse(placesJson);
  } catch (err) {
    console.error("Failed to parse places JSON:", err.message);
    process.exit(1);
  }
  console.log(`  ${places.length} places extracted`);

  // Transform into standard profile format
  const results = [];
  const seenDomains = new Set();
  let skippedNoUrl = 0;
  let skippedSocial = 0;
  let skippedDuplicate = 0;
  let withUrl = 0;

  for (const place of places) {
    const loc = place.location || {};
    const lat = parseFloat(loc.lat) || null;
    const lng = parseFloat(loc.lng) || null;
    const city = loc.city || "";
    const state = loc.state || "";
    const country = loc.country || "United Kingdom";

    // Extract category
    const categories = (place.categories || []).map(c => c.name).filter(Boolean);
    const categoryName = categories[0] || "";

    // Extract website URL from extra_fields HTML anchor
    const extraFields = loc.extra_fields || {};
    const rawWebsite = extraFields.website || "";
    const websiteUrl = fixUrl(extractUrlFromHtml(rawWebsite));

    // Build tags
    const tags = ["community business"];
    if (categoryName) tags.push(categoryName.toLowerCase());

    // Deduplicate by domain if URL exists
    if (websiteUrl) {
      withUrl++;
      if (isSkipUrl(websiteUrl)) { skippedSocial++; continue; }
      let domain;
      try {
        domain = new URL(websiteUrl).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        // ignore
      }
      if (domain) {
        if (seenDomains.has(domain)) { skippedDuplicate++; continue; }
        seenDomains.add(domain);
      }
    }

    results.push({
      name: place.title || "",
      primary_url: websiteUrl,
      profile_url: PAGE_URL,
      description: "",
      latitude: lat,
      longitude: lng,
      locality: city,
      region: state,
      country: country,
      tags,
      source: "plunkett",
    });
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`  Saved to ${OUT_FILE}`);

  // Stats
  console.log("\n--- Stats ---");
  console.log(`Places on map: ${places.length}`);
  console.log(`With website URL: ${withUrl}`);
  console.log(`Skipped (social media): ${skippedSocial}`);
  console.log(`Skipped (duplicate domain): ${skippedDuplicate}`);
  console.log(`Final entries: ${results.length}`);

  // Category breakdown
  const catCounts = {};
  for (const r of results) {
    const cat = r.tags[1] || "(uncategorized)";
    catCounts[cat] = (catCounts[cat] || 0) + 1;
  }
  const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
  console.log("\nCategory breakdown:");
  for (const [cat, count] of sortedCats) {
    console.log(`  ${cat}: ${count}`);
  }

  // Country breakdown
  const countryCounts = {};
  for (const r of results) {
    const key = r.country || "(unknown)";
    countryCounts[key] = (countryCounts[key] || 0) + 1;
  }
  const topCountries = Object.entries(countryCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log("\nCountry breakdown (top 10):");
  for (const [c, count] of topCountries) {
    console.log(`  ${c}: ${count}`);
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
