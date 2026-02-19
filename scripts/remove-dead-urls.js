#!/usr/bin/env node

/**
 * Removes profiles with dead URLs from profiles.json.
 *
 * Reads url-check-results.json (produced by check-urls.js),
 * backs up the current profiles.json, then removes all profiles
 * whose URL check returned "dead".
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILES_PATH = path.join(DATA_DIR, "profiles.json");
const RESULTS_PATH = path.join(DATA_DIR, "url-check-results.json");
const BACKUP_PATH = path.join(DATA_DIR, "profiles-before-url-check.json");

function main() {
  if (!fs.existsSync(RESULTS_PATH)) {
    console.error(`Error: ${RESULTS_PATH} not found. Run check-urls.js first.`);
    process.exit(1);
  }

  const profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
  const results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));

  console.log(`Loaded ${profiles.length} profiles`);
  console.log(`Loaded ${results.length} URL check results`);

  // Build set of dead profile indices
  const deadIndices = new Set(
    results.filter((r) => r.status === "dead").map((r) => r.idx)
  );

  console.log(`Dead URLs: ${deadIndices.size}`);

  // Back up current profiles
  fs.writeFileSync(BACKUP_PATH, JSON.stringify(profiles, null, 2));
  console.log(`Backup saved to ${BACKUP_PATH}`);

  // Filter out dead profiles
  const filtered = profiles.filter((_, i) => !deadIndices.has(i));

  fs.writeFileSync(PROFILES_PATH, JSON.stringify(filtered, null, 2));
  console.log(`\nRemoved ${profiles.length - filtered.length} dead-link profiles. ${filtered.length} profiles remain.`);
}

main();
