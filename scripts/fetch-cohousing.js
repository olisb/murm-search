#!/usr/bin/env node
/**
 * Fetch UK Cohousing Network directory entries.
 * Data is in HTML with data-latlong attributes.
 */
const fs = require("fs");
const path = require("path");

const URL = "https://cohousing.org.uk/information/uk-cohousing-directory/";
const OUT = path.join(__dirname, "..", "data", "cohousing-uk.json");

async function main() {
  console.log("Fetching UK Cohousing Network directory...");
  const res = await fetch(URL, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  const html = await res.text();

  // Extract directory items with data-latlong
  const re = /<div class="directory-list-item"\s+data-latlong="([-0-9.]+)\|([-0-9.]+)">([\s\S]*?)(?=<div class="directory-list-item"|<\/section|$)/g;
  const profiles = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    const card = m[3];

    // Name
    const nameMatch = card.match(/group-title[^>]*><a[^>]*>(.*?)<\/a>/);
    const name = nameMatch ? nameMatch[1].trim() : "";
    if (!name) continue;

    // Link
    const linkMatch = card.match(/href="(https:\/\/cohousing\.org\.uk\/members-directory\/[^"]+)"/);
    const profileLink = linkMatch ? linkMatch[1] : "";

    // Status
    const statusMatch = card.match(/Status[\s\S]*?<li>(.*?)<\/li>/);
    const status = statusMatch ? statusMatch[1].trim() : "";

    // Location/region
    const locMatch = card.match(/Location[\s\S]*?<li>(.*?)<\/li>/);
    const region = locMatch ? locMatch[1].trim() : "";

    // Group types
    const typesMatch = card.match(/Group type[\s\S]*?<ul>([\s\S]*?)<\/ul>/);
    const types = typesMatch
      ? [...typesMatch[1].matchAll(/<li>(.*?)<\/li>/g)].map(m => m[1].trim().toLowerCase())
      : [];

    const tags = ["cohousing", "intentional community", ...types];
    const statusDesc = status ? ` (${status})` : "";

    profiles.push({
      name,
      primary_url: profileLink,
      profile_url: "https://cohousing.org.uk/information/uk-cohousing-directory/",
      description: `Cohousing community${statusDesc}.`,
      latitude: lat,
      longitude: lng,
      locality: "",
      region,
      country: "United Kingdom",
      tags,
      source: "cohousing-uk",
    });
  }

  console.log(`Extracted ${profiles.length} cohousing communities`);
  fs.writeFileSync(OUT, JSON.stringify(profiles, null, 2));
  console.log(`Written to ${OUT}`);
}

main().catch(console.error);
