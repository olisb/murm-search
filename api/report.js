const { Redis } = require("@upstash/redis");

const REPORTS_KEY = "cobot:reports";
const MAX_REPORTS = 1000;

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { profile_url, profile_name, primary_url, report_type, query, message } = req.body;
  if (!profile_url || !report_type) {
    return res.status(400).json({ error: "Missing profile_url or report_type" });
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const report = {
    id,
    profile_url,
    profile_name: profile_name || "",
    primary_url: primary_url || "",
    report_type,
    query: query || "",
    message: message || "",
    timestamp: new Date().toISOString(),
  };

  const r = getRedis();
  if (r) {
    try {
      await r.lpush(REPORTS_KEY, JSON.stringify(report));
      await r.ltrim(REPORTS_KEY, 0, MAX_REPORTS - 1);
    } catch (err) {
      console.error("[report] Redis error:", err.message);
    }
  }

  console.log("[report]", report);
  res.json({ ok: true, id });
};
