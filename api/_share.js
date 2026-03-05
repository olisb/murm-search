/**
 * Share state storage via Upstash Redis.
 * Stores chat/search results for shareable links.
 */

const { Redis } = require("@upstash/redis");

const SHARE_PREFIX = "cobot:share:";
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

function generateId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

async function saveShare(data) {
  const r = getRedis();
  if (!r) throw new Error("Redis not configured");
  const id = generateId();
  await r.set(SHARE_PREFIX + id, JSON.stringify(data), { ex: TTL_SECONDS });
  return id;
}

async function getShare(id) {
  const r = getRedis();
  if (!r) return null;
  const raw = await r.get(SHARE_PREFIX + id);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

module.exports = { saveShare, getShare };
