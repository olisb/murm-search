#!/usr/bin/env node
/**
 * Extract community fridge locations from communityfridgemap.org.uk
 * Data is embedded in Next.js RSC stream with escaped JSON.
 */
const fs = require("fs");
const path = require("path");

const URL = "https://communityfridgemap.org.uk/";
const OUT = path.join(__dirname, "..", "data", "community-fridges-uk.json");

async function main() {
  console.log("Fetching communityfridgemap.org.uk...");
  const res = await fetch(URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await res.text();
  console.log(`Page size: ${(html.length / 1024).toFixed(0)}KB`);

  // RSC stream uses escaped quotes: \"name\":\"...\",\"latitude\":...
  const re = /\\"name\\":\\"(.*?)\\".*?\\"latitude\\":([-0-9.e+]+).*?\\"longitude\\":([-0-9.e+]+).*?\\"address\\":\\"(.*?)\\"/g;
  const fridges = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = m[1].replace(/\\n/g, "").replace(/\\+/g, "").trim();
    const lat = parseFloat(m[2]);
    const lng = parseFloat(m[3]);
    const address = m[4].replace(/\\n/g, ", ").replace(/\\+/g, "").replace(/\s+/g, " ").trim();
    if (!name || isNaN(lat) || isNaN(lng)) continue;

    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Parse address for locality
    const parts = address.split(",").map(s => s.trim()).filter(Boolean);
    // Usually: street, area, city, postcode — take second-to-last as locality
    const locality = parts.length >= 3 ? parts[parts.length - 2] : parts[0] || "";

    fridges.push({
      name,
      primary_url: "",
      profile_url: "https://communityfridgemap.org.uk/",
      description: "Community fridge redistributing surplus food to reduce waste.",
      latitude: lat,
      longitude: lng,
      locality,
      region: "",
      country: "United Kingdom",
      tags: ["community fridge", "food waste", "food sharing"],
      source: "community-fridges-uk",
    });
  }

  console.log(`Extracted ${fridges.length} community fridges`);
  fs.writeFileSync(OUT, JSON.stringify(fridges, null, 2));
  console.log(`Written to ${OUT}`);
}

main().catch(console.error);
