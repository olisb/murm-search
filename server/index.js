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
  return `You are the search interface for the Murmurations network, a directory of ${totalProfiles} organisations in the regenerative economy across ${totalCountries} countries.

The user searches by talking to you. Their messages trigger searches automatically and you see the results below. You ARE the search tool — never tell users to "visit the Murmurations website" or "search directly." Never say you "don't have access" to data.

The user sees result cards and a map below your message — don't repeat what's visible there.

STRICT LIMIT: 30 words or fewer. One or two short sentences only. Plain text. No emoji. No markdown. Talk like a knowledgeable friend.

Add value the cards can't: spot patterns, note gaps, suggest better searches. If results don't match, say so and suggest different terms.

Never claim an organisation is or isn't in the directory — you only see top results, not the full dataset. If results are empty, say you couldn't find matches, not that things don't exist here.

Only say something if it adds information the user can't already see.`;
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

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = client.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      system: systemPrompt,
      messages,
    });

    stream.on("text", (text) => {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });

    stream.on("end", () => {
      res.write("data: [DONE]\n\n");
      res.end();
    });

    stream.on("error", (err) => {
      console.error("[chat] Stream error:", err.message);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });
  } catch (err) {
    console.error("[chat] Error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: `Chat failed: ${err.message}` });
    }
  }
});

// -------------------------------------------------------------------
// Query understanding (single LLM call replaces classifier + rewriter)
// -------------------------------------------------------------------
const UNDERSTAND_PROMPT = `You are the query understanding layer for a search tool that searches a directory of ${totalProfiles} organisations in the regenerative economy across ${totalCountries} countries.

Given the user's message and conversation history, determine what they want and return ONLY a JSON object.

Return this JSON structure:
{
  "action": "search" | "chat",
  "geo": ["location1"] or [],
  "topic": "search terms" or "",
  "queryType": "geo-only" | "topic-only" | "geo+topic",
  "showAll": true | false,
  "chatResponse": "only if action is chat, otherwise omit"
}

Rules:
- action is "search" for ANY message that mentions a topic, category, type of org, or location. This tool exists to search. Default to search.
- action is "chat" ONLY for pure greetings ("hi"), meta-questions about the tool ("what is this", "how does this work"), or feedback ("thanks", "cool")
- NEVER set action to "chat" when the message contains a searchable noun
- geo: extract location names. Resolve aliases: "UK" → ["England","Scotland","Wales","Northern Ireland"], "US"/"USA"/"america" → ["United States"], "deutschland" → ["Germany"], etc. Use the location names as they appear in the database.
- topic: extract the subject matter, ignoring location words and filler. "show me all the orgs you have in australia" → topic is "", geo is ["Australia"], queryType is "geo-only", showAll is true
- When the user says "show me all/everything" or "what have you got" with only a location, set showAll: true, queryType: "geo-only", topic: ""
- queryType: "geo-only" if geo but no topic, "topic-only" if topic but no geo, "geo+topic" if both
- Look at conversation history to resolve follow-ups: "in the USA?" after "renewable energy worldwide" → geo: ["United States"], topic: "renewable energy", queryType: "geo+topic"
- But detect NEW topics: "ok try open source projects" after energy discussion → topic: "open source", geo: [], queryType: "topic-only" (don't carry old geo)
- "is [X] in your data" or "do you have [X]" → search for X
- "show me all [X] you know about" → search for X
- "do you know about [X]" → search for X
- For chat responses: be brief and warm. One sentence. You help people search a directory of organisations in the regenerative economy. Guide them toward searching. No emoji.`;

app.post("/api/understand", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.json({ action: "search", geo: [], topic: req.body.message, queryType: "topic-only", showAll: false });
  }

  try {
    const { message, history = [], sampleLocations = "" } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing message" });
    }

    const locationContext = sampleLocations
      ? `\n\nKnown locations in the database (sample):\n${sampleLocations}`
      : "";

    const messages = [];
    for (const msg of history.slice(-6)) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: "user", content: message });

    const client = new Anthropic();
    const result = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: UNDERSTAND_PROMPT + locationContext,
      messages,
    });

    const text = (result.content[0]?.text || "").trim();
    console.log('[understand]', { message, response: text, historyLength: messages.length });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[understand] No JSON found:', text);
      return res.json({ action: "search", geo: [], topic: message, queryType: "topic-only", showAll: false });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    res.json(parsed);
  } catch (err) {
    console.error("[understand] Error:", err.message);
    res.json({ action: "search", geo: [], topic: req.body.message, queryType: "topic-only", showAll: false });
  }
});

// -------------------------------------------------------------------
// Query rewriter + classifier (legacy, kept for backward compat)
// -------------------------------------------------------------------
const REWRITE_PROMPT = `You rewrite user messages into search queries for an organisation directory. Output ONLY the search terms — no explanation, no quotes.

CRITICAL: almost everything is a SEARCH. The user came here to search. If the message contains ANY topic, subject, or thing to look for — it is a search. Extract the search terms.

NOT_A_SEARCH is ONLY for messages with NO searchable topic at all:
- Pure greetings: "hi", "hey", "how are you", "thanks", "cool"
- Tool questions: "what is this", "how does this work"
- Off-topic: "what's the weather", "tell me a joke"

These are ALL searches — extract the topic:
- "show me X" / "show me all X" → X
- "do you know about X" / "know any X" → X
- "is X in your data/directory" / "do you have X" → X
- "list all X" / "what X do you have" → X
- "are there any X" / "any X" → X
- "I'm looking for X" / "I want to find X" → X
- "what about X" → X (or combine with previous context if it's a refinement)

KEY RULE: if the message contains a real-world topic noun (like "open source", "cooperatives", "energy", "vegan", "housing", "permaculture", "transition towns", or ANY other subject), it is ALWAYS a search — no matter how conversationally phrased.

CONTEXT — refinements vs new topics:
- REFINEMENTS carry context: "any in the US", "what about france", "how about berlin", "more like that" → combine with previous topic.
- NEW TOPICS start fresh: completely different subject, or phrases like "try looking for", "now search", "instead", "something else", or zero keyword overlap with previous topic → output ONLY the new terms.

Examples:
- "renewable energy" → user says "any in cambridge" → "renewable energy cambridge"
- "co-ops in scotland" → "what about housing?" → "housing co-ops in scotland"
- "solar panels france" → "solar panels france"
- "food co-ops london" → "how about brighton" → "food co-ops brighton"
- "renewable energy US" → "ok try looking for open source projects" → "open source projects"
- "vegan berlin" → "now show me cooperatives" → "cooperatives"
- "do you know about any open source projects or orgs" → "open source"
- "show me all open source orgs you know about" → "open source"
- "is murmurations listed in your data" → "murmurations"
- "are there any housing cooperatives" → "housing cooperatives"
- "what open source projects exist" → "open source"
- "hi" → NOT_A_SEARCH
- "thanks that's helpful" → NOT_A_SEARCH`;

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
      system: `You are a friendly assistant for the Murmurations network directory — a searchable database of ${totalProfiles.toLocaleString()} organisations (cooperatives, community projects, Transition Towns, social enterprises) across ${totalCountries} countries. You help people find organisations by topic and location. Keep responses brief and warm. If someone greets you, say hi and tell them what you can help with. Guide them toward searching. Never use emoji. Never use markdown bold, bullet points, or lists. Talk in plain sentences. One sentence for casual chat. Don't explain what the Murmurations network is unless specifically asked. You ARE the search interface — never tell users to "visit the Murmurations website" or "search directly", they are already searching through you. Never say you "don't have access" to the data. Never claim an organisation is or isn't in the directory — you only see top results, not the full dataset.`,
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
// Add profile from URL
// -------------------------------------------------------------------
const USER_PROFILES_PATH = path.join(__dirname, "..", "data", "user-profiles.json");

function loadUserProfiles() {
  try {
    if (fs.existsSync(USER_PROFILES_PATH)) {
      return JSON.parse(fs.readFileSync(USER_PROFILES_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("[user-profiles] Failed to load:", err.message);
  }
  return [];
}

function saveUserProfiles(entries) {
  fs.mkdirSync(path.dirname(USER_PROFILES_PATH), { recursive: true });
  fs.writeFileSync(USER_PROFILES_PATH, JSON.stringify(entries, null, 2));
}

let userProfiles = loadUserProfiles();
console.log(`[user-profiles] Loaded ${userProfiles.length} existing entries`);

app.post("/api/add-profile", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Missing profile URL" });
    }

    // Validate URL format
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL format" });
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "URL must be http or https" });
    }

    // Fetch the profile JSON
    let profileData;
    try {
      const fetchRes = await fetch(url);
      if (!fetchRes.ok) {
        return res.status(400).json({ error: `Could not fetch profile: HTTP ${fetchRes.status}` });
      }
      profileData = await fetchRes.json();
    } catch (err) {
      return res.status(400).json({ error: `Could not fetch profile: ${err.message}` });
    }

    // Normalize fields to match our schema
    const geo = profileData.geolocation || {};
    const tags = profileData.tags || profileData.keywords || [];
    const profile = {
      profile_url: url,
      name: profileData.name || profileData.title || "Unknown",
      description: profileData.description || profileData.mission || null,
      latitude: geo.lat != null ? Number(geo.lat) : (profileData.latitude != null ? Number(profileData.latitude) : null),
      longitude: geo.lon != null ? Number(geo.lon) : (profileData.longitude != null ? Number(profileData.longitude) : null),
      locality: profileData.locality || null,
      region: profileData.region || null,
      country: profileData.country_name || profileData.country || null,
      tags: Array.isArray(tags) ? tags : [],
      primary_url: profileData.primary_url || profileData.url || null,
      image: profileData.image || null,
      source: "user-submitted",
    };

    // Generate embedding
    const embeddingText = `Organisation or project related to: ${profile.name}. ${profile.description || ""}. Tags: ${profile.tags.join(", ")}`;
    const embed = await getEmbedder();
    const output = await embed(embeddingText, { pooling: "mean", normalize: true });
    const embedding = Array.from(output.data);

    // Deduplicate by profile_url
    const existingIdx = userProfiles.findIndex((e) => e.profile.profile_url === url);
    if (existingIdx >= 0) {
      userProfiles[existingIdx] = { profile, embedding };
    } else {
      userProfiles.push({ profile, embedding });
    }

    saveUserProfiles(userProfiles);
    console.log(`[user-profiles] ${existingIdx >= 0 ? "Updated" : "Added"}: ${profile.name}`);

    res.json({ ok: true, profile });
  } catch (err) {
    console.error("[add-profile] Error:", err);
    res.status(500).json({ error: `Failed to add profile: ${err.message}` });
  }
});

// -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Murm Search running at http://localhost:${PORT}`);
  console.log(`  Admin panel: http://localhost:${PORT}/admin`);
  console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "set" : "NOT SET"}\n`);
});
