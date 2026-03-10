#!/usr/bin/env node
/**
 * Merge user-submitted profiles from Redis into the main dataset.
 *
 * Steps:
 *   1. Read user profiles from Upstash Redis
 *   2. Deduplicate against existing profiles.json
 *   3. Append new profiles to profiles.json
 *   4. Clear merged profiles from Redis
 *
 * After running this, regenerate embeddings + map points:
 *   python3 scripts/generate-embeddings.py
 *   python3 scripts/quantize-embeddings.py
 *   node scripts/generate-map-points.js
 *   cp public/data/* (if needed)
 */

require("dotenv").config({ path: ".env.local" });
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { getAllUserProfiles } = require("../api/_user-profiles");
const { Redis } = require("@upstash/redis");

const PROFILES_FILE = path.join(__dirname, "..", "data", "profiles.json");
const REDIS_KEY = "cobot:user-profiles";

async function main() {
  const userProfiles = await getAllUserProfiles();
  if (userProfiles.length === 0) {
    console.log("No user-submitted profiles in Redis.");
    return;
  }
  console.log(`Found ${userProfiles.length} user-submitted profiles in Redis`);

  // Load existing profiles and build dedup sets
  const existing = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
  const existingUrls = new Set();
  const existingKeys = new Set();
  for (const p of existing) {
    if (p.primary_url) {
      existingUrls.add(p.primary_url.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase());
    }
    if (p.profile_url) {
      existingUrls.add(p.profile_url.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase());
    }
    existingKeys.add((p.name + "|" + (p.latitude || "")).toLowerCase());
  }

  let added = 0;
  let dupes = 0;
  for (const p of userProfiles) {
    const key = (p.name + "|" + (p.latitude || "")).toLowerCase();
    const urlKey = p.profile_url ? p.profile_url.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase() : "";
    const primaryUrlKey = p.primary_url ? p.primary_url.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase() : "";

    if (existingKeys.has(key)) { dupes++; continue; }
    if (urlKey && existingUrls.has(urlKey)) { dupes++; continue; }
    if (primaryUrlKey && existingUrls.has(primaryUrlKey)) { dupes++; continue; }

    existing.push(p);
    existingKeys.add(key);
    if (urlKey) existingUrls.add(urlKey);
    if (primaryUrlKey) existingUrls.add(primaryUrlKey);
    added++;
    console.log(`  + ${p.name}`);
  }

  if (added === 0) {
    console.log(`All ${dupes} profiles already in dataset. Nothing to merge.`);
    return;
  }

  fs.writeFileSync(PROFILES_FILE, JSON.stringify(existing, null, 2));
  console.log(`\nMerged ${added} new profiles (${dupes} dupes skipped)`);
  console.log(`Total profiles: ${existing.length}`);

  // Clear user profiles from Redis
  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  await redis.del(REDIS_KEY);
  console.log("Cleared user profiles from Redis");

  console.log(`\nNext steps:
  python3 scripts/generate-embeddings.py
  python3 scripts/quantize-embeddings.py
  node scripts/generate-map-points.js`);
}

main().catch(console.error);
