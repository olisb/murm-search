const { Redis } = require("@upstash/redis");

const REPORTS_KEY = "cobot:reports";

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}

module.exports = async function handler(req, res) {
  if (req.method === "DELETE") {
    // Dismiss a report by id (from path like /api/reports/abc123)
    const id = req.url?.split("/").pop();
    if (!id) return res.status(400).json({ error: "Missing report id" });

    const r = getRedis();
    if (r) {
      try {
        const all = await r.lrange(REPORTS_KEY, 0, -1);
        const filtered = all.filter(entry => {
          const parsed = typeof entry === "string" ? JSON.parse(entry) : entry;
          return parsed.id !== id;
        });
        await r.del(REPORTS_KEY);
        if (filtered.length > 0) {
          await r.rpush(REPORTS_KEY, ...filtered.map(e => typeof e === "string" ? e : JSON.stringify(e)));
        }
      } catch (err) {
        console.error("[reports] Delete error:", err.message);
      }
    }
    return res.json({ ok: true });
  }

  // GET — return all reports
  const r = getRedis();
  if (!r) return res.json([]);

  try {
    const raw = await r.lrange(REPORTS_KEY, 0, -1);
    const reports = raw.map(entry => typeof entry === "string" ? JSON.parse(entry) : entry);
    res.json(reports);
  } catch (err) {
    console.error("[reports] Read error:", err.message);
    res.json([]);
  }
};
