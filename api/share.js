const { saveShare, getShare } = require("./_share");

module.exports = async function handler(req, res) {
  if (req.method === "POST") {
    try {
      const { query, text, results, mode } = req.body;
      if (!query || !results) {
        return res.status(400).json({ error: "Missing query or results" });
      }
      const payload = { query, text: text || "", results, mode: mode || "chat" };
      const size = JSON.stringify(payload).length;
      console.log(`[share] Saving share: ${results.length} results, ${(size/1024).toFixed(1)}KB`);
      const id = await saveShare(payload);
      console.log(`[share] Saved as ${id}`);
      return res.json({ ok: true, id });
    } catch (err) {
      console.error("[share] Save error:", err.message);
      return res.status(500).json({ error: "Failed to save share" });
    }
  }

  if (req.method === "GET") {
    try {
      const id = req.query.id;
      if (!id || !/^[a-z0-9]{6,12}$/.test(id)) {
        return res.status(400).json({ error: "Invalid share ID" });
      }
      const data = await getShare(id);
      if (!data) {
        return res.status(404).json({ error: "Share not found or expired" });
      }
      return res.json({ ok: true, ...data });
    } catch (err) {
      console.error("[share] Get error:", err.message);
      return res.status(500).json({ error: "Failed to load share" });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};
