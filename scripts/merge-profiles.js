#!/usr/bin/env node

/**
 * Merges Murmurations org profiles and KVM profiles into a single dataset.
 * Deduplicates on primary_url — keeps the entry with the longer description.
 * Adds source field to existing profiles if missing.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const ORG_FILE = path.join(DATA_DIR, "profiles.json");
const KVM_FILE = path.join(DATA_DIR, "kvm-profiles.json");

function main() {
  console.log("Loading profiles...");

  const orgs = JSON.parse(fs.readFileSync(ORG_FILE, "utf-8"));
  console.log(`  Org profiles: ${orgs.length}`);

  const kvm = JSON.parse(fs.readFileSync(KVM_FILE, "utf-8"));
  console.log(`  KVM profiles: ${kvm.length}`);

  // Ensure source field on org profiles
  for (const p of orgs) {
    if (!p.source) p.source = "murmurations";
  }

  // Deduplicate on primary_url
  const byUrl = new Map();
  let dupes = 0;

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

  // Collect: profiles with URLs (deduplicated) + profiles without URLs
  const withoutUrl = [...orgs, ...kvm].filter((p) => !p.primary_url);
  const merged = [...byUrl.values(), ...withoutUrl];

  const orgCount = merged.filter((p) => p.source === "murmurations").length;
  const kvmCount = merged.filter((p) => p.source === "kvm").length;

  console.log(`\n  Duplicates removed: ${dupes}`);
  console.log(`  Merged total: ${merged.length}`);
  console.log(`    Murmurations: ${orgCount}`);
  console.log(`    KVM: ${kvmCount}`);

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
