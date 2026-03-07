#!/usr/bin/env node
/**
 * Extract IFAN (Independent Food Aid Network) member data from embedded Sanity CMS data.
 * The data is in unquoted JS object format, not JSON.
 */
const fs = require("fs");
const path = require("path");

const URL = "https://www.foodaidnetwork.org.uk/our-members";
const OUT = path.join(__dirname, "..", "data", "ifan.json");

async function main() {
  console.log("Fetching IFAN members...");
  const res = await fetch(URL, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  const html = await res.text();

  // Extract member objects using regex on the embedded JS data
  // Pattern: name:"...",  with locations containing coordinates
  const memberRe = /\{_id:"[^"]+",[\s\S]*?name:"([^"]+)"[\s\S]*?\}/g;

  // Better approach: find all lat/lng pairs with their surrounding context
  // Each member has: name:"...", locations:[{...coordinates:{_type:"geopoint",lat:XX,lng:YY}...}]
  const profiles = [];
  const seen = new Set();

  // Find all members with coordinates
  // Split by _id to get individual records
  const records = html.split(/\{_id:"/);
  console.log(`Found ${records.length - 1} record chunks`);

  for (const rec of records.slice(1)) {
    // Name
    const nameMatch = rec.match(/name:"([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    // Coordinates (first location)
    const latMatch = rec.match(/lat:([-0-9.]+)/);
    const lngMatch = rec.match(/lng:([-0-9.]+)/);
    if (!latMatch || !lngMatch) continue;
    const lat = parseFloat(latMatch[1]);
    const lng = parseFloat(lngMatch[1]);
    if (isNaN(lat) || isNaN(lng)) continue;

    // Website
    let website = "";
    const webMatch = rec.match(/_type:"website",value:"([^"]+)"/);
    if (webMatch) website = webMatch[1];

    // Postcode
    const pcMatch = rec.match(/postcode:"([^"]+)"/);
    const postcode = pcMatch ? pcMatch[1] : "";

    // Dedup by name
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    profiles.push({
      name,
      primary_url: website,
      profile_url: "https://www.foodaidnetwork.org.uk/our-members",
      description: "Independent food aid provider and IFAN member.",
      latitude: lat,
      longitude: lng,
      locality: "",
      region: "",
      country: "United Kingdom",
      tags: ["food bank", "food aid", "IFAN member"],
      source: "ifan",
    });
  }

  console.log(`Extracted ${profiles.length} IFAN members`);
  fs.writeFileSync(OUT, JSON.stringify(profiles, null, 2));
  console.log(`Written to ${OUT}`);
}

main().catch(console.error);
