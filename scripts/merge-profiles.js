#!/usr/bin/env node

/**
 * Merges Murmurations org profiles, KVM profiles, and all OSM category files
 * into a single dataset.
 * Deduplicates on primary_url — for Murmurations/KVM, keeps the entry with the
 * longer description. OSM entries are only added if no Murmurations/KVM entry
 * exists for the same URL (Murm/KVM always wins over OSM).
 * Adds source field to existing profiles if missing.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const ORG_FILE = path.join(DATA_DIR, "profiles.json");
const KVM_FILE = path.join(DATA_DIR, "kvm-profiles.json");

// All OSM category output files — add new ones here as categories are added
// All OSM category output files — add new ones here as categories are added
const OSM_FILES = [
  path.join(DATA_DIR, "osm-hackerspaces.json"),
  path.join(DATA_DIR, "osm-cooperatives.json"),
  path.join(DATA_DIR, "osm-repair_cafes.json"),
  path.join(DATA_DIR, "osm-coworking.json"),
  path.join(DATA_DIR, "osm-zero_waste.json"),
  path.join(DATA_DIR, "osm-fair_trade.json"),
];

function main() {
  console.log("Loading profiles...");

  const orgs = JSON.parse(fs.readFileSync(ORG_FILE, "utf-8"));
  console.log(`  Org profiles: ${orgs.length}`);

  const kvm = JSON.parse(fs.readFileSync(KVM_FILE, "utf-8"));
  console.log(`  KVM profiles: ${kvm.length}`);

  let osm = [];
  for (const osmFile of OSM_FILES) {
    const label = path.basename(osmFile, ".json");
    try {
      const data = JSON.parse(fs.readFileSync(osmFile, "utf-8"));
      console.log(`  ${label}: ${data.length}`);
      osm.push(...data);
    } catch {
      console.log(`  ${label}: 0 (file not found, skipping)`);
    }
  }
  console.log(`  OSM total: ${osm.length}`);

  // Ensure source field on org profiles
  for (const p of orgs) {
    if (!p.source) p.source = "murmurations";
  }

  // Deduplicate on primary_url
  const byUrl = new Map();
  let dupes = 0;

  // First pass: merge Murmurations and KVM (longer description wins on dupes)
  for (const p of [...orgs, ...kvm]) {
    if (!p.primary_url) {
      // No URL — can't deduplicate, just keep it
      continue;
    }

    const key = p.primary_url.toLowerCase().replace(/\/+$/, "");
    const existing = byUrl.get(key);

    if (!existing) {
      byUrl.set(key, p);
    } else {
      dupes++;
      // Keep whichever has the longer description
      const existingLen = (existing.description || "").length;
      const newLen = (p.description || "").length;
      if (newLen > existingLen) {
        byUrl.set(key, p);
      }
    }
  }

  // Second pass: add OSM entries only if URL not already present (Murm/KVM always wins)
  let osmDupes = 0;
  for (const p of osm) {
    if (!p.primary_url) {
      continue;
    }

    const key = p.primary_url.toLowerCase().replace(/\/+$/, "");
    if (!byUrl.has(key)) {
      byUrl.set(key, p);
    } else {
      osmDupes++;
      dupes++;
    }
  }

  // Collect: profiles with URLs (deduplicated) + profiles without URLs
  const withoutUrl = [...orgs, ...kvm, ...osm].filter((p) => !p.primary_url);
  const merged = [...byUrl.values(), ...withoutUrl];

  const orgCount = merged.filter((p) => p.source === "murmurations").length;
  const kvmCount = merged.filter((p) => p.source === "kvm").length;
  const osmCount = merged.filter((p) => p.source === "openstreetmap").length;

  console.log(`\n  Duplicates removed: ${dupes}`);
  console.log(`  Merged total: ${merged.length}`);
  console.log(`    Murmurations: ${orgCount}`);
  console.log(`    KVM: ${kvmCount}`);
  console.log(`    OSM: ${osmCount}`);

  // Backup original
  const backupPath = path.join(DATA_DIR, "profiles-orgs-only.json");
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(ORG_FILE, backupPath);
    console.log(`\n  Backed up original to ${backupPath}`);
  }

  fs.writeFileSync(ORG_FILE, JSON.stringify(merged, null, 2));
  console.log(`  Saved merged dataset to ${ORG_FILE}`);
}

main();
