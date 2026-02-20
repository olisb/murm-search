#!/usr/bin/env node

/**
 * Validates every primary_url in the merged profiles.json.
 * Removes profiles with dead websites and logs failures.
 * Run AFTER merge-profiles.js and BEFORE generate-embeddings.py.
 */

const fs = require("fs");
const path = require("path");

const CONCURRENCY = 15;
const URL_TIMEOUT = 8000;
const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const LOG_FILE = path.join(DATA_DIR, "dead-links.log");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeSemaphore(max) {
  let running = 0;
  const queue = [];

  return function acquire() {
    return new Promise((resolve) => {
      const tryRun = () => {
        if (running < max) {
          running++;
          resolve(() => {
            running--;
            if (queue.length > 0) queue.shift()();
          });
        } else {
          queue.push(tryRun);
        }
      };
      tryRun();
    });
  };
}

async function main() {
  const startTime = Date.now();

  const profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
  console.log(`Loaded ${profiles.length} profiles from ${PROFILES_FILE}`);

  // Split into profiles with and without URLs
  const withUrl = profiles.filter((p) => p.primary_url);
  const withoutUrl = profiles.filter((p) => !p.primary_url);
  console.log(`  ${withUrl.length} with URLs, ${withoutUrl.length} without (kept as-is)\n`);

  const acquire = makeSemaphore(CONCURRENCY);
  const logLines = [];
  let passed = 0;
  let failed = 0;
  let done = 0;
  const total = withUrl.length;

  console.log(`Validating ${total} URLs (concurrency=${CONCURRENCY}, timeout=${URL_TIMEOUT}ms)...`);

  const results = await Promise.all(
    withUrl.map(async (profile) => {
      const release = await acquire();
      try {
        // Skip URLs that can't be parsed
        let url;
        try {
          url = new URL(profile.primary_url);
        } catch {
          failed++;
          logLines.push(`FAIL bad_url ${profile.primary_url}`);
          return null;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), URL_TIMEOUT);
        try {
          const res = await fetch(url.href, {
            method: "HEAD",
            signal: controller.signal,
            redirect: "follow",
          });
          clearTimeout(timer);
          if (res.status >= 200 && res.status < 400) {
            passed++;
            return profile;
          } else {
            failed++;
            logLines.push(`FAIL ${res.status} ${profile.primary_url}`);
            return null;
          }
        } catch (err) {
          clearTimeout(timer);
          failed++;
          const reason = err.name === "AbortError" ? "TIMEOUT" : err.message;
          logLines.push(`FAIL ${reason} ${profile.primary_url}`);
          return null;
        }
      } finally {
        done++;
        if (done % 50 === 0 || done === total) {
          process.stdout.write(`\r  ${done}/${total} checked (${passed} ok, ${failed} dead)`);
        }
        release();
      }
    })
  );

  const valid = results.filter(Boolean);
  const final = [...valid, ...withoutUrl];

  console.log(`\n\nURL validation complete:`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`  ${final.length} profiles remaining (was ${profiles.length})\n`);

  // Write dead links log
  if (logLines.length > 0) {
    fs.writeFileSync(LOG_FILE, logLines.join("\n") + "\n");
    console.log(`Dead links logged to ${LOG_FILE}`);
  }

  // Overwrite profiles.json with only valid entries
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(final, null, 2));
  console.log(`Saved ${final.length} validated profiles to ${PROFILES_FILE}`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
