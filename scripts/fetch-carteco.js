#!/usr/bin/env node

/**
 * Fetches social/solidarity economy data from CartEco (carteco-ess.org).
 * Source: https://carteco-ess.org/annuaire
 * API: https://carteco-ess.org/api/elements.json (GoGoCarto platform)
 *
 * Contains ~4,800 French ESS organisations: waste management, recycling,
 * sustainable agriculture, repair, social enterprises, etc.
 * Licensed under ODbL for names, SIRET, status, public contacts, hours, addresses, locations.
 *
 * Usage:
 *   node scripts/fetch-carteco.js
 */

const fs = require("fs");
const path = require("path");

const API_URL = "https://carteco-ess.org/api/elements.json";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(DATA_DIR, "carteco-ess.json");
const FETCH_TIMEOUT = 120000;

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
  if (!url || url === "NULL") return null;
  if (url.includes(";")) url = url.split(";")[0].trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

// Map French region names from categories to normalised names
const REGION_NAMES = new Set([
  "Auvergne-Rhône-Alpes", "Bourgogne-Franche-Comté", "Bretagne",
  "Centre-Val de Loire", "Corse", "Grand Est", "Hauts-de-France",
  "Île-de-France", "Normandie", "Nouvelle Aquitaine", "Occitanie",
  "Pays de la Loire", "Provence-Alpes-Côte d'Azur", "La Réunion",
  "Guadeloupe", "Martinique", "Guyane", "Mayotte",
]);

// Map activity categories to tags
const CATEGORY_TAGS = {
  "Gestion des ressources et déchets": "waste management",
  "Agriculture et alimentation durables": "sustainable agriculture",
  "Seconde vie des produits (collecte, réparation, réemploi...)": "reuse and repair",
  "Réparation": "repair",
  "Réemploi": "reuse",
  "Recyclerie / Ressourcerie": "recycling centre",
  "Sensibilisation à la prévention": "education",
  "Ecoconception": "eco-design",
  "Bâtiment durable": "sustainable building",
  "Recherche & développement": "research",
  "Récupération d'invendus": "food rescue",
};

function buildTags(categories, statutEss) {
  const tags = ["social enterprise"];
  if (statutEss) {
    const lower = statutEss.toLowerCase();
    if (lower.includes("coopérative") || lower.includes("scop") || lower.includes("scic")) {
      tags.push("cooperative");
    }
  }

  const seen = new Set(tags);
  for (const cat of categories) {
    const tag = CATEGORY_TAGS[cat];
    if (tag && !seen.has(tag)) {
      tags.push(tag);
      seen.add(tag);
    }
  }
  return tags;
}

function extractRegion(categories) {
  for (const cat of categories) {
    if (REGION_NAMES.has(cat)) return cat;
  }
  return "";
}

async function main() {
  console.log("Fetching CartEco ESS directory...");
  const res = await fetch(API_URL, {
    headers: { "User-Agent": "CoBot/1.0 (community directory)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }
  const json = await res.json();
  const data = json.data || [];
  console.log(`  ${data.length} entries from API`);

  // Clean and filter
  const results = [];
  let skippedNoUrl = 0;
  let skippedSocial = 0;
  const seenDomains = new Set();
  let skippedDuplicate = 0;

  for (const entry of data) {
    const url = fixUrl(entry.site_web);
    if (!url) { skippedNoUrl++; continue; }
    if (isSkipUrl(url)) { skippedSocial++; continue; }

    let domain;
    try {
      domain = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      skippedNoUrl++;
      continue;
    }
    if (seenDomains.has(domain)) { skippedDuplicate++; continue; }
    seenDomains.add(domain);

    const lat = entry.geo?.latitude || null;
    const lng = entry.geo?.longitude || null;
    const categories = entry.categories || [];
    const region = extractRegion(categories);
    const tags = buildTags(categories, entry.statut_ess);
    const locality = entry.address?.addressLocality || "";

    const desc = (entry.description_activite || "").trim();

    results.push({
      name: entry.name || "",
      description: desc,
      primary_url: url,
      profile_url: `https://carteco-ess.org/#/fiche/${entry.id}/`,
      latitude: lat,
      longitude: lng,
      locality,
      region,
      country: "France",
      tags,
      source: "carteco",
    });
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`  Saved to ${OUT_FILE}`);

  // Stats
  console.log("\n--- Stats ---");
  console.log(`API entries: ${data.length}`);
  console.log(`Skipped (no URL): ${skippedNoUrl}`);
  console.log(`Skipped (social media): ${skippedSocial}`);
  console.log(`Skipped (duplicate domain): ${skippedDuplicate}`);
  console.log(`Final entries: ${results.length}`);

  // Region breakdown
  const regionCounts = {};
  for (const r of results) {
    const key = r.region || "(unknown)";
    regionCounts[key] = (regionCounts[key] || 0) + 1;
  }
  const topRegions = Object.entries(regionCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log("\nRegion breakdown:");
  for (const [region, count] of topRegions) {
    console.log(`  ${region}: ${count}`);
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
