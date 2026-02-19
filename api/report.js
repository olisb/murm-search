module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { profile_url, profile_name, primary_url, report_type, query, message } = req.body;
  if (!profile_url || !report_type) {
    return res.status(400).json({ error: "Missing profile_url or report_type" });
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  console.log("[report]", { id, profile_url, profile_name, primary_url, report_type, query, message });

  res.json({ ok: true, id });
};
