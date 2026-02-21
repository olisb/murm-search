const Anthropic = require("@anthropic-ai/sdk");
const { getStats } = require("./_stats");

// Lazy-import the search module for internal search
let searchModule = null;
function getSearchModule() {
  if (!searchModule) searchModule = require("./search");
  return searchModule;
}

function buildSystemPrompt() {
  const { totalProfiles, totalCountries } = getStats();
  return `You are CoBot, a search tool that combines data from the Murmurations network and OpenStreetMap to provide a directory of ${totalProfiles} co-ops, commons, community organisations, hackerspaces, makerspaces, coworking spaces, repair cafes, zero waste, fair trade, charity and farm shops, nature reserves and NGOs across ${totalCountries} countries.

The user searches by talking to you. Their messages trigger searches automatically and you see the results below. You ARE the search tool — never tell users to "visit the Murmurations website" or "search directly." Never say you "don't have access" to data.

The user sees result cards and a map below your message — don't repeat what's visible there.

STRICT LIMIT: 30 words or fewer. One or two short sentences only. Plain text. No emoji. No markdown. Talk like a knowledgeable friend.

Add value the cards can't: spot patterns, note gaps, suggest better searches. If results don't match, say so and suggest different terms. When suggesting a search, wrap it in quotes like "renewable energy cooperatives" so users can click it.

Never claim an organisation is or isn't in the directory — you only see top results, not the full dataset. If results are empty, say you couldn't find matches, not that things don't exist here.`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(501).json({ error: "No ANTHROPIC_API_KEY configured — chat mode requires an API key. Switch to Search mode." });
  }

  try {
    const { query, geo, topic, queryType: reqQueryType, showAll, geoNote: reqGeoNote, history = [] } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing query" });
    }

    // Run search internally via a mock req/res to reuse the search endpoint
    const searchResults = await new Promise((resolve, reject) => {
      const mockReq = {
        method: "POST",
        body: { query, geo, topic, queryType: reqQueryType, showAll },
      };
      const mockRes = {
        status: (code) => ({ json: (data) => reject(new Error(data.error || "Search failed")) }),
        json: (data) => resolve(data),
      };
      getSearchModule()(mockReq, mockRes).catch(reject);
    });

    const profileList = searchResults.results.slice(0, 8);
    const total = searchResults.totalResults || profileList.length;
    const geoNote = reqGeoNote || searchResults.geoNote;
    const geoTerms = searchResults.geoTerms || [];
    const topicKeywords = searchResults.topicWords || [];

    const geoStr = geoTerms.length > 0 ? geoTerms.join(", ") : "none";
    const topicStr = topicKeywords.length > 0 ? topicKeywords.join(", ") : "none";

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
- Query type: ${searchResults.queryType || reqQueryType || "unknown"}
- Location filter: ${geoStr}
- Topic filter: ${topicStr}${geoNote ? `\n- Note: ${geoNote}` : ""}`;

    const userMessage = `User query: "${query}"\n\n${metadata}\n\n${profileContext}`;

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
      max_tokens: 120,
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
};
