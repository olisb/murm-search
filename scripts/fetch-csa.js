#!/usr/bin/env node
/**
 * Fetch CSA Network UK farms from FacetWP map data.
 */
const fs = require("fs");
const path = require("path");

const URL = "https://communitysupportedagriculture.org.uk/find-a-csa/";
const OUT = path.join(__dirname, "..", "data", "csa-network.json");

async function main() {
  console.log("Fetching CSA Network UK...");
  const res = await fetch(URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await res.text();

  // Extract locations array from FacetWP map config using bracket matching
  const start = html.indexOf('"locations":[');
  if (start < 0) { console.log("No locations found"); return; }
  const arrStart = html.indexOf("[", start);
  let depth = 0, end = arrStart;
  for (let i = arrStart; i < html.length; i++) {
    if (html[i] === "[") depth++;
    else if (html[i] === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const locations = JSON.parse(html.slice(arrStart, end));
  console.log(`Found ${locations.length} map locations`);

  const profiles = [];
  for (const loc of locations) {
    const lat = loc.position?.lat;
    const lng = loc.position?.lng;
    if (!lat || !lng) continue;

    const nameMatch = loc.content?.match(/title="([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : "";
    const linkMatch = loc.content?.match(/href="([^"]+)"/);
    const link = linkMatch ? linkMatch[1].replace(/\\\//g, "/") : "";
    const addrMatch = loc.content?.match(/class="address">(.*?)<\/p>/s);
    const address = addrMatch ? addrMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    if (!name) continue;
    const parts = address.split(",").map(s => s.trim()).filter(Boolean);
    const locality = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || "";

    profiles.push({
      name,
      primary_url: link,
      profile_url: "https://communitysupportedagriculture.org.uk/find-a-csa/",
      description: "Community Supported Agriculture farm providing locally grown food.",
      latitude: lat,
      longitude: lng,
      locality,
      region: "",
      country: "United Kingdom",
      tags: ["community supported agriculture", "CSA", "local food"],
      source: "csa-network",
    });
  }

  console.log(`Extracted ${profiles.length} CSA farms`);
  fs.writeFileSync(OUT, JSON.stringify(profiles, null, 2));
  console.log(`Written to ${OUT}`);
}

main().catch(console.error);
