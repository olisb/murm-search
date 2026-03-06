#!/usr/bin/env node
/**
 * Parse NAVCA Members KML file into profiles.
 * Input: /Users/olisb/Downloads/NAVCA Members.kml
 * Output: data/navca.json
 *
 * NAVCA = National Association for Voluntary and Community Action
 * These are local voluntary/community support organisations across England.
 */

const fs = require("fs");
const path = require("path");

const KML_PATH = "/Users/olisb/Downloads/NAVCA Members.kml";
const OUT_PATH = path.join(__dirname, "..", "data", "navca.json");

const kml = fs.readFileSync(KML_PATH, "utf-8");

// Extract all Placemarks
const placemarks = [...kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)].map(m => m[1]);
console.log(`Found ${placemarks.length} placemarks`);

function stripCdata(s) {
  return s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
}

function extract(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? stripCdata(m[1].trim()) : "";
}

function extractData(xml, name) {
  const re = new RegExp(`<Data name="${name}">[\\s\\S]*?<value>([\\s\\S]*?)<\\/value>`, "i");
  const m = xml.match(re);
  return m ? stripCdata(m[1].trim()) : "";
}

// Geocode UK postcodes via postcodes.io (free, no API key)
async function geocodePostcode(postcode) {
  try {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
    const data = await res.json();
    if (data.status === 200 && data.result) {
      return {
        latitude: data.result.latitude,
        longitude: data.result.longitude,
        locality: data.result.admin_ward || data.result.parish || "",
        region: data.result.admin_county || data.result.region || "",
      };
    }
  } catch (err) {
    // ignore
  }
  return null;
}

async function main() {
  const profiles = [];
  let geocoded = 0;

  for (const pm of placemarks) {
    const name = extract(pm, "name");
    if (!name) continue;

    // Coordinates from KML
    const coordStr = extract(pm, "coordinates");
    let latitude = null, longitude = null;
    if (coordStr) {
      const parts = coordStr.split(",").map(s => parseFloat(s.trim()));
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        longitude = parts[0];
        latitude = parts[1];
      }
    }

    // ExtendedData fields
    const address = extractData(pm, "Address");
    const postcode = extractData(pm, "Postcode") || extract(pm, "address");
    let website = extractData(pm, "Website");

    // Normalise URL
    if (website && !website.startsWith("http")) {
      website = "https://" + website;
    }

    // Parse address lines for locality
    const addrLines = address.split("\n").map(s => s.trim()).filter(Boolean);
    let locality = addrLines.length >= 2 ? addrLines[addrLines.length - 2] : (addrLines[0] || "");
    let region = addrLines.length >= 2 ? addrLines[addrLines.length - 1] : "";

    // Geocode if no coordinates
    if ((!latitude || !longitude) && postcode) {
      const geo = await geocodePostcode(postcode);
      if (geo) {
        latitude = geo.latitude;
        longitude = geo.longitude;
        if (!locality) locality = geo.locality;
        if (!region) region = geo.region;
        geocoded++;
      }
    }

    if (!latitude || !longitude) continue;

    profiles.push({
      name,
      primary_url: website || "",
      profile_url: "https://navca.org.uk/find-a-member",
      description: `NAVCA member organisation providing voluntary and community support services.`,
      latitude,
      longitude,
      locality: locality || "",
      region: region || "",
      country: "United Kingdom",
      tags: ["voluntary sector", "community support", "NAVCA member"],
      source: "navca",
    });
  }

  console.log(`Parsed ${profiles.length} profiles (${geocoded} geocoded from postcode)`);

  fs.writeFileSync(OUT_PATH, JSON.stringify(profiles, null, 2));
  console.log(`Written to ${OUT_PATH}`);
}

main();
