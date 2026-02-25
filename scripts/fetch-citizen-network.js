#!/usr/bin/env node

/**
 * Fetches community groups from Citizen Network's map.
 * Source: https://citizen-network.org/map
 * API endpoint returns markers with HTML content containing org details.
 * Then scrapes each profile page for the org's actual website URL.
 *
 * Usage:
 *   node scripts/fetch-citizen-network.js
 */

const fs = require("fs");
const path = require("path");

const API_URL = "https://citizen-network.org/app/actions/map/members.php?country=";
const BASE_URL = "https://citizen-network.org";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "citizen-network.json");
const CONCURRENCY = 5;
const DELAY_BETWEEN_BATCHES = 1000;

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;amp;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lsquo;/g, "\u2018")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&mdash;/g, "\u2014");
}

function parseMarkerHtml(html) {
  const nameMatch = html.match(/<a href="\/map\/[^"]*">([^<]+)<\/a>/);
  const name = nameMatch ? decodeHtmlEntities(nameMatch[1].trim()) : null;

  const slugMatch = html.match(/<a href="(\/map\/[^"]+)"/);
  const slug = slugMatch ? slugMatch[1] : null;

  const descParts = [];
  const descRegex = /p-map-marker__desc">([^<]+)<\/p>/g;
  let m;
  while ((m = descRegex.exec(html)) !== null) {
    descParts.push(decodeHtmlEntities(m[1].trim()));
  }

  const address = descParts.length > 0 ? descParts[0] : null;
  const description = descParts.length > 1 ? descParts.slice(1).join(" ") : null;

  return { name, slug, address, description };
}

const SKIP_DOMAINS = new Set([
  "citizen-network.org", "facebook.com", "twitter.com", "linkedin.com",
  "instagram.com", "youtube.com", "google.com", "bsky.app", "x.com",
  "designition.co.uk", "welp.fi",
]);

function isSkipUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return SKIP_DOMAINS.has(host) || SKIP_DOMAINS.has(host.split(".").slice(-2).join("."));
  } catch {
    return true;
  }
}

async function scrapeWebsiteUrl(profilePath) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${BASE_URL}${profilePath}`, {
      headers: { "User-Agent": "CoBot/1.0 (community directory)" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const html = await res.text();

    // The org website URL appears in the main content area after the address.
    // Find the main content section (after navigation, before footer)
    const mainStart = html.indexOf('<main') || html.indexOf('class="p-member"') || html.indexOf('class="l-content"');
    const mainEnd = html.indexOf('<footer') || html.length;
    const mainHtml = mainStart > 0 ? html.slice(mainStart, mainEnd > mainStart ? mainEnd : undefined) : html;

    // Collect all external links from the main content
    const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/gi;
    let match;
    while ((match = linkRegex.exec(mainHtml)) !== null) {
      const url = match[1];
      if (!isSkipUrl(url)) return url;
    }
    return null;
  } catch {
    return null;
  }
}

async function main() {
  console.log("Fetching Citizen Network members...");

  const res = await fetch(API_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }

  const data = await res.json();
  const markers = data.markers || [];
  console.log(`  ${markers.length} markers received`);

  const profiles = [];
  const seen = new Set();

  for (const marker of markers) {
    const parsed = parseMarkerHtml(marker.content || "");
    if (!parsed.name) continue;

    const key = parsed.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    profiles.push({
      name: parsed.name,
      description: parsed.description || "",
      primary_url: "",
      profile_url: parsed.slug ? `${BASE_URL}${parsed.slug}` : "",
      latitude: parseFloat(marker.latitude) || null,
      longitude: parseFloat(marker.longitude) || null,
      locality: parsed.address || "",
      region: "",
      country: "",
      tags: ["citizen network", "community"],
      source: "citizen-network",
      _slug: parsed.slug,
    });
  }

  console.log(`  ${profiles.length} unique profiles`);

  // Scrape actual website URLs from profile pages
  console.log(`  Scraping website URLs (concurrency ${CONCURRENCY})...`);
  let found = 0;
  for (let i = 0; i < profiles.length; i += CONCURRENCY) {
    const batch = profiles.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (p) => {
        if (!p._slug) return null;
        return scrapeWebsiteUrl(p._slug);
      })
    );
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) {
        batch[j].primary_url = results[j];
        found++;
      }
    }
    const done = Math.min(i + CONCURRENCY, profiles.length);
    process.stdout.write(`\r  ${done}/${profiles.length} scraped, ${found} websites found`);
    if (i + CONCURRENCY < profiles.length) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
    }
  }
  console.log();

  // Clean up temp fields
  for (const p of profiles) delete p._slug;

  // Only keep profiles with a website
  const withWebsite = profiles.filter(p => p.primary_url);
  console.log(`  ${withWebsite.length} profiles with external websites (of ${profiles.length} total)`);

  fs.writeFileSync(OUT_FILE, JSON.stringify(withWebsite, null, 2));
  console.log(`  Saved to ${OUT_FILE}`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
