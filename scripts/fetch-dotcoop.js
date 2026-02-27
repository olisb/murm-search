#!/usr/bin/env node

/**
 * Fetches cooperative data from the .coop domain directory (directory.coop).
 * Source: https://data.digitalcommons.coop/dotcoop/standard.csv
 *
 * Data is from WHOIS registration of .coop domains, maintained by DotCooperation.
 * Licensed under ODbL for names, addresses, and public contact info.
 *
 * Usage:
 *   node scripts/fetch-dotcoop.js
 */

const fs = require("fs");
const path = require("path");

const CSV_URL = "https://data.digitalcommons.coop/dotcoop/standard.csv";
const VOCABS_URL = "https://data.digitalcommons.coop/dotcoop/dotcoop-vocabs.json";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "dotcoop-directory.json");
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
  if (!url) return null;
  url = url.trim();
  if (!url) return null;
  // Handle semicolon-separated URLs — take the first one
  if (url.includes(";")) url = url.split(";")[0].trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

function parseCSV(text) {
  const lines = text.split("\n");
  const headers = parseCSVLine(lines[0]);
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[j] || "";
    }
    results.push(obj);
  }
  return results;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

async function main() {
  // Fetch CSV
  console.log("Fetching .coop directory CSV...");
  const res = await fetch(CSV_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }
  const csvText = await res.text();
  const rows = parseCSV(csvText);
  console.log(`  ${rows.length} entries in CSV`);

  // Fetch vocabulary for sector decoding
  console.log("Fetching sector vocabulary...");
  let sectorMap = {};
  try {
    const vocabRes = await fetch(VOCABS_URL, {
      headers: { "User-Agent": "CoBot/1.0 (community directory)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (vocabRes.ok) {
      const vocabs = await vocabRes.json();
      // Build sector ID -> name mapping
      if (vocabs.sectors) {
        for (const s of vocabs.sectors) {
          if (s.id && s.label) sectorMap[s.id] = s.label;
        }
      }
      console.log(`  ${Object.keys(sectorMap).length} sector mappings loaded`);
    }
  } catch {
    console.log("  Could not load vocabs, continuing without sector names");
  }

  // Clean and filter
  console.log("Cleaning and filtering...");
  const results = [];
  let skippedNoUrl = 0;
  let skippedSocial = 0;
  const seenDomains = new Set();
  let skippedDuplicate = 0;

  for (const row of rows) {
    const url = fixUrl(row["Website"]);
    if (!url) { skippedNoUrl++; continue; }
    if (isSkipUrl(url)) { skippedSocial++; continue; }

    // Deduplicate by domain
    let domain;
    try {
      domain = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      skippedNoUrl++;
      continue;
    }
    if (seenDomains.has(domain)) { skippedDuplicate++; continue; }
    seenDomains.add(domain);

    // Get coordinates from Geo Container fields
    const lat = parseFloat(row["Geo Container Latitude"]) || null;
    const lon = parseFloat(row["Geo Container Longitude"]) || null;

    // Decode sector
    const sectorId = row["Economic Sector ID"] || "";
    const sectorName = sectorMap[sectorId] || "";

    // Build tags
    const tags = ["cooperative"];
    if (sectorName) {
      const lower = sectorName.toLowerCase();
      if (lower.includes("credit union")) tags.push("credit union");
      else if (lower.includes("housing")) tags.push("housing cooperative");
      else if (lower.includes("agriculture") || lower.includes("farming")) tags.push("agricultural cooperative");
      else if (lower.includes("insurance")) tags.push("insurance cooperative");
      else if (lower.includes("financial")) tags.push("financial cooperative");
      else if (lower.includes("health")) tags.push("health cooperative");
      else if (lower.includes("education")) tags.push("education");
      else if (lower.includes("energy") || lower.includes("utilities")) tags.push("energy cooperative");
      else if (lower.includes("consumer") || lower.includes("retail")) tags.push("consumer cooperative");
      else if (lower.includes("worker")) tags.push("worker cooperative");
    }

    results.push({
      name: row["Name"] || "",
      description: row["Description"] || "",
      primary_url: url,
      profile_url: url,
      latitude: lat,
      longitude: lon,
      locality: row["Locality"] || "",
      region: row["Region"] || "",
      country: row["Country ID"] || "",
      tags,
      source: "dotcoop",
    });
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`  Saved to ${OUT_FILE}`);

  // Stats
  console.log("\n--- Stats ---");
  console.log(`CSV entries: ${rows.length}`);
  console.log(`Skipped (no URL): ${skippedNoUrl}`);
  console.log(`Skipped (social media): ${skippedSocial}`);
  console.log(`Skipped (duplicate domain): ${skippedDuplicate}`);
  console.log(`Final entries: ${results.length}`);

  // Country breakdown (top 10)
  const countryCounts = {};
  for (const r of results) {
    const key = r.country || "(unknown)";
    countryCounts[key] = (countryCounts[key] || 0) + 1;
  }
  const topCountries = Object.entries(countryCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log("\nCountry breakdown (top 15):");
  for (const [country, count] of topCountries) {
    console.log(`  ${country}: ${count}`);
  }

  // Tag breakdown
  const tagCounts = {};
  for (const r of results) {
    for (const t of r.tags) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }
  console.log("\nTag breakdown:");
  for (const [tag, count] of Object.entries(tagCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tag}: ${count}`);
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
