/**
 * Query logging via Upstash Redis.
 * Logs search and chat queries with timestamps.
 *
 * Env vars needed:
 *   KV_REST_API_URL  — Upstash Redis REST URL
 *   KV_REST_API_TOKEN — Upstash Redis REST token
 *   ADMIN_PASSWORD — password for admin page access
 */

const { Redis } = require("@upstash/redis");

const LOG_KEY = "cobot:query_log";
const MAX_ENTRIES = 5000;

let redis = null;

function getRedis() {
  if (redis) return redis;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  return redis;
}

async function logQuery({ type, query, geo, topic, queryType, resultCount, ip }) {
  const r = getRedis();
  if (!r) return;
  try {
    const entry = {
      type,
      query: query || "",
      geo: geo || [],
      topic: topic || "",
      queryType: queryType || "",
      resultCount: resultCount || 0,
      ip: ip ? ip.replace(/^::ffff:/, "") : "",
      ts: new Date().toISOString(),
    };
    await r.lpush(LOG_KEY, JSON.stringify(entry));
    await r.ltrim(LOG_KEY, 0, MAX_ENTRIES - 1);
  } catch (err) {
    console.error("[log] Failed to log query:", err.message);
  }
}

async function getQueryLogs(count = 200) {
  const r = getRedis();
  if (!r) return [];
  try {
    const raw = await r.lrange(LOG_KEY, 0, count - 1);
    return raw.map(entry => typeof entry === "string" ? JSON.parse(entry) : entry);
  } catch (err) {
    console.error("[log] Failed to read logs:", err.message);
    return [];
  }
}

module.exports = { logQuery, getQueryLogs };
