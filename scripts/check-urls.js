#!/usr/bin/env node

/**
 * Checks every primary_url in profiles.json for liveness.
 *
 * - HEAD request first (falls back to GET on 405)
 * - 10s timeout, follows up to 5 redirects
 * - Dead = DNS failure, connection refused, timeout, HTTP 4xx/5xx
 * - Alive = HTTP 2xx or 3xx
 *
 * Saves progress every 500 profiles so it can be stopped and resumed.
 * Results written to data/url-check-results.json.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILES_PATH = path.join(DATA_DIR, "profiles.json");
const RESULTS_PATH = path.join(DATA_DIR, "url-check-results.json");
const PROGRESS_PATH = path.join(DATA_DIR, "url-check-progress.json");

const CONCURRENCY = 30;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const CHECKPOINT_EVERY = 500;

// Custom TLS-tolerant agent — many of these sites have bad certs
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function normalizeUrl(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  return url;
}

function checkUrl(rawUrl) {
  return new Promise((resolve) => {
    const url = normalizeUrl(rawUrl);
    attemptRequest(url, "HEAD", 0, resolve);
  });
}

function attemptRequest(url, method, redirectCount, resolve) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return resolve({ status: "dead", httpCode: null, error: "INVALID_URL" });
  }

  const isHttps = parsed.protocol === "https:";
  const lib = isHttps ? https : http;
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method,
    timeout: TIMEOUT_MS,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; URLChecker/1.0)",
    },
  };
  if (isHttps) options.agent = httpsAgent;

  const req = lib.request(options, (res) => {
    // Consume body to free socket
    res.resume();

    const code = res.statusCode;

    // Follow redirects
    if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
      if (redirectCount >= MAX_REDIRECTS) {
        return resolve({ status: "dead", httpCode: code, error: "TOO_MANY_REDIRECTS" });
      }
      let next = res.headers.location;
      if (next.startsWith("/")) {
        next = `${parsed.protocol}//${parsed.host}${next}`;
      }
      return attemptRequest(next, method, redirectCount + 1, resolve);
    }

    // HEAD returned 405 — retry with GET
    if (code === 405 && method === "HEAD") {
      return attemptRequest(url, "GET", redirectCount, resolve);
    }

    if (code >= 200 && code < 400) {
      return resolve({ status: "alive", httpCode: code });
    }

    return resolve({ status: "dead", httpCode: code, error: `HTTP_${code}` });
  });

  req.on("timeout", () => {
    req.destroy();
    resolve({ status: "dead", httpCode: null, error: "TIMEOUT" });
  });

  req.on("error", (err) => {
    const code = err.code || err.message;
    // If HTTPS fails with a protocol-level error, try HTTP as fallback
    if (isHttps && method === "HEAD" && redirectCount === 0 &&
        (code === "ERR_SSL_WRONG_VERSION_NUMBER" || code === "EPROTO" ||
         code === "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")) {
      const httpUrl = url.replace(/^https:/, "http:");
      return attemptRequest(httpUrl, method, redirectCount, resolve);
    }
    resolve({ status: "dead", httpCode: null, error: code });
  });

  req.end();
}

function loadProgress() {
  try {
    const raw = fs.readFileSync(PROGRESS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { checked: [], lastIdx: -1 };
  }
}

function saveProgress(checked, lastIdx) {
  fs.writeFileSync(
    PROGRESS_PATH,
    JSON.stringify({ checked, lastIdx }, null, 2)
  );
}

async function main() {
  const startTime = Date.now();
  const profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
  console.log(`Loaded ${profiles.length} profiles`);

  // Build work list: only profiles with a primary_url
  const work = [];
  for (let i = 0; i < profiles.length; i++) {
    if (profiles[i].primary_url) {
      work.push({ idx: i, url: profiles[i].primary_url });
    }
  }
  console.log(`${work.length} profiles have a primary_url to check`);

  // Load checkpoint
  const progress = loadProgress();
  const doneSet = new Set(progress.checked.map((c) => c.idx));
  const results = [...progress.checked];
  let alive = results.filter((r) => r.status === "alive").length;
  let dead = results.filter((r) => r.status === "dead").length;

  const remaining = work.filter((w) => !doneSet.has(w.idx));
  if (remaining.length < work.length) {
    console.log(`Resuming: ${work.length - remaining.length} already checked, ${remaining.length} remaining`);
  }

  let checked = results.length;
  let lastCheckpoint = checked;

  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);

    const batchResults = await Promise.all(
      batch.map(async ({ idx, url }) => {
        const result = await checkUrl(url);
        return { idx, url, ...result };
      })
    );

    for (const r of batchResults) {
      results.push(r);
      if (r.status === "alive") alive++;
      else dead++;
      checked++;
    }

    const pct = ((dead / checked) * 100).toFixed(1);
    process.stdout.write(
      `\rChecked ${checked}/${work.length} | alive: ${alive} | dead: ${dead} (${pct}%)`
    );

    // Checkpoint
    if (checked - lastCheckpoint >= CHECKPOINT_EVERY) {
      saveProgress(results, results[results.length - 1].idx);
      lastCheckpoint = checked;
    }
  }

  console.log("\n");

  // Sort by original index
  results.sort((a, b) => a.idx - b.idx);

  // Save final results
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log(`Results saved to ${RESULTS_PATH}`);
  console.log(`  Alive: ${alive}`);
  console.log(`  Dead:  ${dead}`);

  // Clean up progress file
  try { fs.unlinkSync(PROGRESS_PATH); } catch {}

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
