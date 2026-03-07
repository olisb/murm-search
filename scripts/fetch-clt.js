#!/usr/bin/env node
/**
 * Parse Community Land Trust locations from Google My Maps KML export.
 * KML pre-downloaded to data/clt-network-raw.kml
 * Geocodes postcodes via postcodes.io
 */
const fs = require("fs");
const path = require("path");

const KML_PATH = path.join(__dirname, "..", "data", "clt-network-raw.kml");
const OUT = path.join(__dirname, "..", "data", "clt-network.json");

const kml = fs.readFileSync(KML_PATH, "utf-8");
const placemarks = [...kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)].map(m => m[1]);
console.log(`Found ${placemarks.length} placemarks`);

function extract(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim() : "";
}

// Batch geocode postcodes via postcodes.io (max 100 per request)
async function batchGeocode(postcodes) {
  const results = {};
  for (let i = 0; i < postcodes.length; i += 100) {
    const batch = postcodes.slice(i, i + 100);
    try {
      const res = await fetch("https://api.postcodes.io/postcodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postcodes: batch }),
      });
      const data = await res.json();
      if (data.result) {
        for (const r of data.result) {
          if (r.result) {
            results[r.query] = {
              latitude: r.result.latitude,
              longitude: r.result.longitude,
              locality: r.result.admin_ward || r.result.parish || "",
              region: r.result.admin_county || r.result.region || "",
            };
          }
        }
      }
    } catch (err) {
      console.error(`Geocode batch error:`, err.message);
    }
  }
  return results;
}

async function main() {
  // Parse placemarks
  const entries = [];
  for (const pm of placemarks) {
    const name = extract(pm, "name").replace(/<[^>]+>/g, "").trim();
    if (!name) continue;

    const address = extract(pm, "address");
    const desc = extract(pm, "description");

    // Extract postcode from address field
    const pcMatch = address.match(/([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d?[A-Z]{0,2})/i);
    const postcode = pcMatch ? pcMatch[1].trim().toUpperCase() : "";

    // Check for coordinates
    const coordStr = extract(pm, "coordinates");
    let latitude = null, longitude = null;
    if (coordStr) {
      const parts = coordStr.split(",").map(s => parseFloat(s.trim()));
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        longitude = parts[0];
        latitude = parts[1];
      }
    }

    // Extract website from description if HTML
    let website = "";
    const urlMatch = desc.match(/href=["']?(https?:\/\/[^\s"'<>]+)/i);
    if (urlMatch) website = urlMatch[1].replace(/\/+$/, "");

    entries.push({ name, postcode, latitude, longitude, website });
  }

  // Geocode entries without coordinates
  const needGeocode = entries.filter(e => !e.latitude && e.postcode);
  console.log(`${entries.length} entries, ${needGeocode.length} need geocoding`);

  const postcodes = [...new Set(needGeocode.map(e => e.postcode))];
  const geo = await batchGeocode(postcodes);
  console.log(`Geocoded ${Object.keys(geo).length}/${postcodes.length} postcodes`);

  const profiles = [];
  const seen = new Set();

  for (const e of entries) {
    let { latitude, longitude } = e;
    let locality = "", region = "";

    if (!latitude && e.postcode && geo[e.postcode]) {
      latitude = geo[e.postcode].latitude;
      longitude = geo[e.postcode].longitude;
      locality = geo[e.postcode].locality;
      region = geo[e.postcode].region;
    }

    if (!latitude || !longitude) continue;

    const key = e.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    profiles.push({
      name: e.name,
      primary_url: e.website,
      profile_url: "https://www.communitylandtrusts.org.uk/about-clts/find-a-community-land-trust/",
      description: "Community Land Trust providing affordable community-owned housing and assets.",
      latitude, longitude,
      locality, region,
      country: "United Kingdom",
      tags: ["community land trust", "affordable housing", "community-owned"],
      source: "clt-network",
    });
  }

  console.log(`Parsed ${profiles.length} CLT profiles`);
  fs.writeFileSync(OUT, JSON.stringify(profiles, null, 2));
  console.log(`Written to ${OUT}`);
}

main().catch(console.error);
