#!/usr/bin/env node

/**
 * Fetches cooperative data from ESSApp (Argentine social/solidarity economy directory).
 * Source: https://www.essapp.coop
 *
 * Phase 1: Downloads the master node list from puntos.json (~6,936 entries).
 * Phase 2: Scrapes each node page to extract website URL, description, and email.
 * Phase 3: Cleans, filters, and outputs the final dataset.
 *
 * Supports checkpointing — safe to interrupt and resume.
 *
 * Usage:
 *   node scripts/fetch-essapp.js
 */

const fs = require("fs");
const path = require("path");

const PUNTOS_URL = "https://www.essapp.coop/files/puntos.json";
const BASE_URL = "https://www.essapp.coop/node/";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "essapp.json");
const CHECKPOINT_FILE = path.join(DATA_DIR, "checkpoint-essapp-scrape.json");
const CONCURRENCY = 5;
const DELAY_BETWEEN_BATCHES = 200;
const FETCH_TIMEOUT = 15000;
const CHECKPOINT_INTERVAL = 500;

const PROVINCES = {
  'K': 'Catamarca', 'H': 'Chaco', 'U': 'Chubut',
  'C': 'Ciudad Autónoma de Buenos Aires', 'X': 'Córdoba',
  'W': 'Corrientes', 'E': 'Entre Ríos', 'P': 'Formosa',
  'Y': 'Jujuy', 'L': 'La Pampa', 'F': 'La Rioja',
  'M': 'Mendoza', 'N': 'Misiones', 'Q': 'Neuquén',
  'B': 'Buenos Aires', 'R': 'Río Negro', 'A': 'Salta',
  'J': 'San Juan', 'D': 'San Luis', 'Z': 'Santa Cruz',
  'S': 'Santa Fe', 'G': 'Santiago del Estero',
  'V': 'Tierra del Fuego', 'T': 'Tucumán',
};

const TYPE_TAGS = {
  'cooperativa': ['cooperative'],
  'medios': ['cooperative', 'community media'],
  'universidades': ['cooperative', 'education'],
  'ferias_espacios': ['cooperative', 'marketplace'],
};

const SKIP_DOMAINS = new Set([
  "facebook.com", "instagram.com", "twitter.com",
  "x.com", "youtube.com", "tiktok.com",
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
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

function stripHtml(str) {
  if (!str) return "";
  return str
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLocality(dir) {
  if (!dir) return "";
  const parts = dir.split(",").map(p => p.trim());
  if (parts.length >= 2) {
    return parts[parts.length - 1];
  }
  return "";
}

async function scrapeNodePage(nid) {
  try {
    const res = await fetch(`${BASE_URL}${nid}`, {
      headers: { "User-Agent": "CoBot/1.0 (community directory)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) return { website: null, description: "", email: "" };
    const html = await res.text();

    // Extract website URL
    let website = null;
    const siteMatch = html.match(/views-field-field-sitio-web[\s\S]*?href="([^"]*)"/);
    if (siteMatch) {
      website = siteMatch[1];
    }

    // Extract description
    let description = "";
    const descMatch = html.match(/field-name-field-cuerpo[\s\S]*?<p>([\s\S]*?)<\/p>/);
    if (descMatch) {
      description = stripHtml(descMatch[1]);
    }

    // Extract email
    let email = "";
    const emailMatch = html.match(/views-field-field-email[\s\S]*?<[^>]*>([^<]*@[^<]*)<\//);
    if (emailMatch) {
      email = emailMatch[1].trim();
    }

    return { website, description, email };
  } catch {
    return { website: null, description: "", email: "" };
  }
}

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
      console.log(`  Resuming from checkpoint: ${Object.keys(data).length} nodes already scraped`);
      return data;
    }
  } catch {
    console.log("  Could not load checkpoint, starting fresh");
  }
  return {};
}

function saveCheckpoint(scraped) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(scraped));
}

async function main() {
  // Phase 1: Fetch puntos.json
  console.log("Phase 1: Fetching puntos.json...");
  const res = await fetch(PUNTOS_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }

  const data = await res.json();
  const nodes = data.nodes || [];
  console.log(`  ${nodes.length} nodes in puntos.json`);

  // Phase 2: Scrape node pages
  console.log(`Phase 2: Scraping node pages (concurrency ${CONCURRENCY})...`);
  const scraped = loadCheckpoint();
  let scrapedCount = Object.keys(scraped).length;
  let successCount = 0;

  // Count already-successful scrapes from checkpoint
  for (const nid of Object.keys(scraped)) {
    if (scraped[nid].website) successCount++;
  }

  const toScrape = nodes.filter(n => {
    const nid = n.node?.nid;
    return nid && !scraped[nid];
  });

  console.log(`  ${toScrape.length} nodes remaining to scrape`);

  for (let i = 0; i < toScrape.length; i += CONCURRENCY) {
    const batch = toScrape.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(n => scrapeNodePage(n.node.nid))
    );

    for (let j = 0; j < batch.length; j++) {
      const nid = batch[j].node.nid;
      scraped[nid] = results[j];
      scrapedCount++;
      if (results[j].website) successCount++;
    }

    // Progress every 200 entries
    const done = Math.min(i + CONCURRENCY, toScrape.length);
    if (done % 200 < CONCURRENCY || done === toScrape.length) {
      const total = nodes.length;
      process.stdout.write(`\r  ${scrapedCount}/${total} scraped, ${successCount} with website`);
    }

    // Checkpoint every 500 entries
    if (done % CHECKPOINT_INTERVAL < CONCURRENCY) {
      saveCheckpoint(scraped);
    }

    if (i + CONCURRENCY < toScrape.length) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
    }
  }

  // Final checkpoint
  saveCheckpoint(scraped);
  console.log();

  // Phase 3: Clean and output
  console.log("Phase 3: Cleaning and outputting...");

  const results = [];
  let skippedNoUrl = 0;
  let skippedSocial = 0;

  for (const entry of nodes) {
    const n = entry.node;
    if (!n || !n.nid) continue;

    const scrapeData = scraped[n.nid] || {};
    let url = fixUrl(scrapeData.website);

    if (!url) {
      skippedNoUrl++;
      continue;
    }

    if (isSkipUrl(url)) {
      skippedSocial++;
      continue;
    }

    const tags = TYPE_TAGS[n.tipo] || ['cooperative'];
    const region = PROVINCES[n.prv] || "";

    results.push({
      name: (n.nom || "").trim(),
      description: scrapeData.description || "",
      primary_url: url,
      profile_url: `https://www.essapp.coop/node/${n.nid}`,
      latitude: parseFloat(n.lat) || null,
      longitude: parseFloat(n.lon) || null,
      locality: extractLocality(n.dir),
      region,
      country: "Argentina",
      tags,
      source: "essapp",
    });
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`  Saved to ${OUT_FILE}`);

  // Stats
  console.log("\n--- Stats ---");
  console.log(`Total nodes in puntos.json: ${nodes.length}`);
  console.log(`Pages scraped successfully: ${scrapedCount}`);
  console.log(`With website URL: ${successCount}`);
  console.log(`Skipped (no URL): ${skippedNoUrl}`);
  console.log(`Skipped (social media): ${skippedSocial}`);
  console.log(`Final kept count: ${results.length}`);

  // Region breakdown (top 10)
  const regionCounts = {};
  for (const r of results) {
    const key = r.region || "(unknown)";
    regionCounts[key] = (regionCounts[key] || 0) + 1;
  }
  const topRegions = Object.entries(regionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log("\nRegion breakdown (top 10):");
  for (const [region, count] of topRegions) {
    console.log(`  ${region}: ${count}`);
  }

  // Type breakdown
  const typeCounts = {};
  for (const entry of nodes) {
    const tipo = entry.node?.tipo || "(unknown)";
    typeCounts[tipo] = (typeCounts[tipo] || 0) + 1;
  }
  console.log("\nType breakdown:");
  for (const [tipo, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tipo}: ${count}`);
  }

  // Clean up checkpoint on success
  if (fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
    console.log("\nCheckpoint file removed (scrape complete).");
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
