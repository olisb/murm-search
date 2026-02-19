const Anthropic = require("@anthropic-ai/sdk");

const totalProfiles = 16885;
const totalCountries = 314;

function buildSystemPrompt() {
  return `You are a search assistant for the Murmurations network, a directory of ${totalProfiles} organisations in the regenerative economy across ${totalCountries} countries.

The user sees result cards and a map below your message — don't repeat what's visible there.

You receive the user's query, search metadata, and top results.

Reply in one sentence. Make it count. Plain text only — no emoji, no markdown bold, no bullet points, no lists of options. Talk like a knowledgeable friend texting back.

Add value the cards can't: spot patterns, note gaps, suggest better searches, or connect dots. If results don't match, say so plainly and suggest different terms.

Only say something if it adds information the user can't already see. Never restate what the user searched for — if they asked for co-ops, don't tell them they're co-ops. If you have nothing genuinely new to add, just state the count and stop. Specific details about individual results are welcome when they're interesting. Generic observations are not.`;
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
    const { query, profiles: profileList = [], totalResults, geoNote,
            queryType, geoTerms, topicKeywords, history = [] } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing query" });
    }

    const total = totalResults != null ? totalResults : profileList.length;

    const geoStr = geoTerms && geoTerms.length > 0 ? geoTerms.join(", ") : "none";
    const topicStr = topicKeywords && topicKeywords.length > 0 ? topicKeywords.join(", ") : "none";

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
};
