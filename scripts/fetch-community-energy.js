#!/usr/bin/env node
/**
 * Fetch Community Energy England members from their /our-members/ page.
 * Data is in HTML article cards with data-lat/data-lng attributes.
 */
const fs = require("fs");
const path = require("path");

const URL = "https://communityenergyengland.org/our-members/";
const OUT = path.join(__dirname, "..", "data", "community-energy.json");

async function main() {
  console.log("Fetching Community Energy England members...");
  const res = await fetch(URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await res.text();

  const re = /<article class="organisation-card"\s+data-lat="([-0-9.]+)"\s+data-lng="([-0-9.]+)">([\s\S]*?)<\/article>/g;
  const profiles = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    const card = m[3];

    const nameMatch = card.match(/organisation-card__title[^>]*>\s*([\s\S]*?)\s*<\/h3>/);
    const name = nameMatch ? nameMatch[1].trim() : "";
    if (!name) continue;

    const regionMatch = card.match(/<strong>Region:<\/strong>\s*(.*?)\s*<\/p>/);
    const region = regionMatch ? regionMatch[1].trim() : "";

    let website = "";
    const urlMatch = card.match(/href="(https?:\/\/(?!communityenergyengland)[^"]+)"/);
    if (urlMatch) website = urlMatch[1];

    const techs = [];
    const techRe = /data-tooltip="([^"]+)"/g;
    let tm;
    while ((tm = techRe.exec(card)) !== null) {
      techs.push(tm[1].toLowerCase());
    }

    profiles.push({
      name,
      primary_url: website,
      profile_url: "https://communityenergyengland.org/our-members/",
      description: `Community energy organisation${techs.length ? " focused on " + techs.join(", ") : ""}.`,
      latitude: lat,
      longitude: lng,
      locality: "",
      region,
      country: "United Kingdom",
      tags: ["community energy", ...techs],
      source: "community-energy",
    });
  }

  console.log(`Extracted ${profiles.length} community energy organisations`);
  fs.writeFileSync(OUT, JSON.stringify(profiles, null, 2));
  console.log(`Written to ${OUT}`);
}

main().catch(console.error);
