/**
 * User-submitted profile storage via Upstash Redis.
 * Profiles are stored as a JSON array under a single key.
 */

const { Redis } = require("@upstash/redis");

const KEY = "cobot:user-profiles";

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

async function saveUserProfile(profile) {
  const r = getRedis();
  if (!r) return false;
  const all = await getAllUserProfiles();
  const idx = all.findIndex(p => p.profile_url === profile.profile_url);
  if (idx >= 0) {
    all[idx] = profile;
  } else {
    all.push(profile);
  }
  await r.set(KEY, JSON.stringify(all));
  return true;
}

async function getAllUserProfiles() {
  const r = getRedis();
  if (!r) return [];
  try {
    const raw = await r.get(KEY);
    if (!raw) return [];
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
}

module.exports = { saveUserProfile, getAllUserProfiles };
