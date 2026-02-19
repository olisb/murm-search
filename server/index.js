require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json({ limit: "2mb" }));

// Load profile stats for system prompt
const PROFILES_PATH = path.join(__dirname, "..", "data", "profiles.json");
let totalProfiles = 0;
let totalCountries = 0;
try {
  const allProfiles = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
  totalProfiles = allProfiles.length;
  totalCountries = new Set(allProfiles.map((p) => p.country).filter(Boolean)).size;
  console.log(`  Loaded stats: ${totalProfiles} profiles, ${totalCountries} countries`);
} catch (err) {
  console.warn("  Could not load profile stats:", err.message);
}

// Static files (no caching during development)
app.use("/", express.static(path.join(__dirname, "..", "src"), { etag: false, lastModified: false, setHeaders: (res) => res.set("Cache-Control", "no-store") }));
app.use("/data", express.static(path.join(__dirname, "..", "data")));

// -------------------------------------------------------------------
// Reports
// -------------------------------------------------------------------
const REPORTS_PATH = path.join(__dirname, "..", "data", "reports.json");

function loadReports() {
  try {
    if (fs.existsSync(REPORTS_PATH)) {
      return JSON.parse(fs.readFileSync(REPORTS_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("[reports] Failed to load:", err.message);
  }
  return [];
}

function saveReports(reports) {
  fs.mkdirSync(path.dirname(REPORTS_PATH), { recursive: true });
  fs.writeFileSync(REPORTS_PATH, JSON.stringify(reports, null, 2));
}

let reports = loadReports();
console.log(`[reports] Loaded ${reports.length} existing reports`);

// Compute penalty map: profile_url -> multiplier
function computePenalties() {
  const penalties = {};
  const deadLinks = {};     // profile_url -> count
  const irrelevantQs = {};  // profile_url -> Set of unique queries

  for (const r of reports) {
    if (r.report_type === "dead_link") {
      deadLinks[r.profile_url] = (deadLinks[r.profile_url] || 0) + 1;
    } else if (r.report_type === "irrelevant") {
      if (!irrelevantQs[r.profile_url]) irrelevantQs[r.profile_url] = new Set();
      irrelevantQs[r.profile_url].add(r.query || "");
    }
  }

  for (const [url, count] of Object.entries(deadLinks)) {
    penalties[url] = 0.1; // dead links get buried
  }

  for (const [url, queries] of Object.entries(irrelevantQs)) {
    const factor = Math.max(0.5, Math.pow(0.9, queries.size));
    penalties[url] = Math.min(penalties[url] ?? 1, factor);
  }

  return penalties;
}

app.get("/api/reports", (req, res) => {
  res.json(reports);
});

app.get("/api/penalties", (req, res) => {
  res.json(computePenalties());
});

app.post("/api/report", (req, res) => {
  const { profile_url, profile_name, primary_url, report_type, query, message } = req.body;
  if (!profile_url || !report_type) {
    return res.status(400).json({ error: "Missing profile_url or report_type" });
  }

  const report = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    profile_url,
    profile_name: profile_name || null,
    primary_url: primary_url || null,
    report_type,
    query: query || null,
    message: message || null,
    timestamp: new Date().toISOString(),
  };

  reports.push(report);
  saveReports(reports);

  res.json({ ok: true, id: report.id });
});

app.delete("/api/reports/:id", (req, res) => {
  const idx = reports.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  reports.splice(idx, 1);
  saveReports(reports);
  res.json({ ok: true });
});

// -------------------------------------------------------------------
// Admin page
// -------------------------------------------------------------------
app.get("/admin", (req, res) => {
  const deadCount = reports.filter((r) => r.report_type === "dead_link").length;
  const irrelCount = reports.filter((r) => r.report_type === "irrelevant").length;
  const feedbackCount = reports.filter((r) => r.report_type === "feedback").length;

  const rows = [...reports]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((r) => `
      <tr data-id="${r.id}">
        <td>${r.timestamp.slice(0, 16).replace("T", " ")}</td>
        <td><span class="rtype rtype-${r.report_type}">${r.report_type}</span></td>
        <td>${esc(r.profile_name || "—")}</td>
        <td>${r.primary_url ? `<a href="${esc(r.primary_url)}" target="_blank">${esc(r.primary_url)}</a>` : "—"}</td>
        <td>${esc(r.query || "—")}</td>
        <td>${esc(r.message || "—")}</td>
        <td><button onclick="dismiss('${r.id}', this)">Dismiss</button></td>
      </tr>
    `)
    .join("");

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Murm Search — Admin Reports</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1210; color: #d4ddd6; padding: 24px; }
  h1 { font-size: 22px; margin-bottom: 16px; }
  h1 span { color: #4ecb71; }
  .summary { display: flex; gap: 16px; margin-bottom: 20px; }
  .stat { padding: 12px 20px; background: #171d19; border: 1px solid #2a3630; border-radius: 8px; font-size: 14px; }
  .stat strong { color: #4ecb71; font-size: 20px; display: block; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; background: #171d19; border-bottom: 2px solid #2a3630; color: #7a8f80; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; }
  th:hover { color: #4ecb71; }
  td { padding: 8px 10px; border-bottom: 1px solid #1c2420; vertical-align: top; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tr:hover td { background: #1c2420; }
  a { color: #4ecb71; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .rtype { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .rtype-dead_link { background: #3a1a1a; color: #e87070; }
  .rtype-irrelevant { background: #3a3010; color: #d4a940; }
  .rtype-feedback { background: #1a2e22; color: #6bc88a; }
  button { padding: 4px 10px; background: #1c2420; border: 1px solid #2a3630; border-radius: 4px; color: #7a8f80; cursor: pointer; font-size: 12px; }
  button:hover { color: #e87070; border-color: #e87070; }
  .empty { text-align: center; padding: 40px; color: #4e6055; }
  .back { display: inline-block; margin-bottom: 16px; color: #4ecb71; text-decoration: none; font-size: 13px; }
</style>
</head>
<body>
  <a href="/" class="back">← Back to search</a>
  <h1>murm<span>search</span> reports</h1>
  <div class="summary">
    <div class="stat"><strong>${deadCount}</strong>Dead links</div>
    <div class="stat"><strong>${irrelCount}</strong>Irrelevant flags</div>
    <div class="stat"><strong>${feedbackCount}</strong>Feedback</div>
    <div class="stat"><strong>${reports.length}</strong>Total</div>
  </div>
  ${reports.length === 0
    ? '<div class="empty">No reports yet.</div>'
    : `<table>
    <thead><tr>
      <th>Time</th><th>Type</th><th>Profile</th><th>URL</th><th>Query</th><th>Message</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
  <script>
    async function dismiss(id, btn) {
      if (!confirm("Dismiss this report?")) return;
      const res = await fetch("/api/reports/" + id, { method: "DELETE" });
      if (res.ok) btn.closest("tr").remove();
    }
    // Column sorting
    document.querySelectorAll("th").forEach((th, col) => {
      th.addEventListener("click", () => {
        const tbody = document.querySelector("tbody");
        const rows = [...tbody.querySelectorAll("tr")];
        const dir = th.dataset.dir === "asc" ? "desc" : "asc";
        th.dataset.dir = dir;
        rows.sort((a, b) => {
          const at = a.children[col]?.textContent || "";
          const bt = b.children[col]?.textContent || "";
          return dir === "asc" ? at.localeCompare(bt) : bt.localeCompare(at);
        });
        rows.forEach(r => tbody.appendChild(r));
      });
    });
  </script>
</body>
</html>`);
});

// -------------------------------------------------------------------
// Query embedding via Transformers.js (loads model on first request)
// -------------------------------------------------------------------
let pipeline = null;
let embedder = null;

async function getEmbedder() {
  if (embedder) return embedder;
  const { pipeline: pipelineFn } = await import("@xenova/transformers");
  pipeline = pipelineFn;
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  return embedder;
}

app.post("/api/embed", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing query string" });
    }

    const embed = await getEmbedder();
    const output = await embed(query, { pooling: "mean", normalize: true });
    const vector = Array.from(output.data);

    res.json({ embedding: vector });
  } catch (err) {
    console.error("Embed error:", err);
    res.status(500).json({ error: "Embedding failed" });
  }
});

// -------------------------------------------------------------------
// Chat endpoint
// -------------------------------------------------------------------
function buildSystemPrompt() {
  return `You are a search assistant for the Murmurations network, a directory of ${totalProfiles} organisations in the regenerative economy across ${totalCountries} countries.

The user sees result cards and a map below your message — don't repeat what's visible there.

You receive the user's query, search metadata, and top results.

Reply in one sentence. Make it count. Plain text only — no emoji, no markdown bold, no bullet points, no lists of options. Talk like a knowledgeable friend texting back.

Add value the cards can't: spot patterns, note gaps, suggest better searches, or connect dots. If results don't match, say so plainly and suggest different terms.

Only say something if it adds information the user can't already see. Never restate what the user searched for — if they asked for co-ops, don't tell them they're co-ops. If you have nothing genuinely new to add, just state the count and stop. Specific details about individual results are welcome when they're interesting. Generic observations are not.`;
}


app.post("/api/chat", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(501).json({ error: "No ANTHROPIC_API_KEY configured — chat mode requires an API key. Switch to Search mode." });
  }

  try {
    const { query, profiles: profileList = [], totalResults, geoNote,
            queryType, geoTerms, topicKeywords, history = [] } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing query" });
    }

    const total = totalResults != null ? totalResults : profileList.length;

    const geoStr = geoTerms && geoTerms.length > 0 ? geoTerms.join(", ") : "none";
    const topicStr = topicKeywords && topicKeywords.length > 0 ? topicKeywords.join(", ") : "none";

    // Build profile context
    const profileContext = profileList
      .slice(0, 8)
      .map((p, i) => {
        const loc = [p.locality, p.region, p.country].filter(Boolean).join(", ");
        const tags = (p.tags || []).join(", ");
        const url = p.primary_url || "no website";
        const desc = (p.description || "No description available.").slice(0, 400);
        const relevance = p._relevance != null ? `${p._relevance}%` : "n/a";
        return `${i + 1}. (relevance: ${relevance}) ${p.name}\n   Location: ${loc || "unknown"}\n   Description: ${desc}\n   Tags: ${tags || "none"}\n   Website: ${url}`;
      })
      .join("\n\n");

    const metadata = `Search metadata:
- Total matches: ${total} (showing top ${profileList.length})
- Query type: ${queryType || "unknown"}
- Location filter: ${geoStr}
- Topic filter: ${topicStr}${geoNote ? `\n- Note: ${geoNote}` : ""}`;

    const userMessage = `User query: "${query}"\n\n${metadata}\n\n${profileContext}`;

    // Build messages with conversation history
    const messages = [];
    for (const msg of history.slice(-10)) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: "user", content: userMessage });

    const systemPrompt = buildSystemPrompt();
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 150,
      system: systemPrompt,
      messages,
    });

    const text = message.content[0]?.text || "";
    if (!text) {
      return res.status(500).json({ error: "Empty response from Claude" });
    }

    res.json({ response: text });
  } catch (err) {
    console.error("[chat] Error:", err.message);
    res.status(500).json({ error: `Chat failed: ${err.message}` });
  }
});

// -------------------------------------------------------------------
// Query rewriter + classifier
// -------------------------------------------------------------------
const REWRITE_PROMPT = `You are a query rewriter for a directory search tool. The user is having a conversation about finding organisations.

Given the conversation history and the user's latest message, output ONLY the full search query that captures what they're actually looking for. No explanation, just the search terms.

Examples:
- History: user searched "renewable energy" → user says "any in cambridge" → Output: "renewable energy cambridge"
- History: user searched "co-ops in scotland" → user says "what about housing?" → Output: "housing co-ops in scotland"
- History: none → user says "solar panels france" → Output: "solar panels france"
- History: user searched "food co-ops london" → user says "how about brighton" → Output: "food co-ops brighton"
- If the message is general chat (greetings, questions about the tool, not a search): Output exactly NOT_A_SEARCH`;

app.post("/api/rewrite", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No API key — just pass through the query as-is
    return res.json({ query: req.body.query, isChat: false });
  }

  try {
    const { query, history = [] } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing query" });
    }

    const messages = [];
    for (const msg of history.slice(-4)) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: "user", content: query });

    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 60,
      system: REWRITE_PROMPT,
      messages,
    });

    const rewritten = (message.content[0]?.text || query).trim().replace(/^["']|["']$/g, "");

    console.log('[rewrite]', { original: query, rewritten, historyLength: messages.length });

    if (rewritten === "NOT_A_SEARCH" || rewritten.toLowerCase() === "not_a_search") {
      return res.json({ query: query, isChat: true });
    }

    res.json({ query: rewritten, isChat: false });
  } catch (err) {
    console.error("[rewrite] Error:", err.message);
    // On error, fall through with original query
    res.json({ query: req.body.query, isChat: false });
  }
});

// -------------------------------------------------------------------
// Conversational (non-search) chat
// -------------------------------------------------------------------
app.post("/api/chat-conversational", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(501).json({ error: "No API key configured" });
  }

  try {
    const { query, history = [] } = req.body;

    const messages = [];
    for (const msg of history.slice(-10)) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: "user", content: query });

    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: `You are a friendly assistant for the Murmurations network directory — a searchable database of ${totalProfiles.toLocaleString()} organisations (cooperatives, community projects, Transition Towns, social enterprises) across ${totalCountries} countries. You help people find organisations by topic and location. Keep responses brief and warm. If someone greets you, say hi and tell them what you can help with. Guide them toward searching. Never use emoji. Never use markdown bold, bullet points, or lists. Talk in plain sentences. One sentence for casual chat. Don't explain what the Murmurations network is unless specifically asked.`,
      messages,
    });

    const text = message.content[0]?.text || "";
    res.json({ response: text });
  } catch (err) {
    console.error("[chat-conversational] Error:", err.message);
    res.status(500).json({ error: `Chat failed: ${err.message}` });
  }
});

// -------------------------------------------------------------------
// Check if chat is available (API key configured)
// -------------------------------------------------------------------
app.get("/api/chat-available", (req, res) => {
  res.json({ available: !!process.env.ANTHROPIC_API_KEY });
});

// -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Murm Search running at http://localhost:${PORT}`);
  console.log(`  Admin panel: http://localhost:${PORT}/admin`);
  console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "set" : "NOT SET"}\n`);
});
