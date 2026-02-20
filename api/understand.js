const Anthropic = require("@anthropic-ai/sdk");

const totalProfiles = 16885;
const totalCountries = 314;

const UNDERSTAND_PROMPT = `You are the query understanding layer for CoBot, a search tool for the Murmurations network — a directory of ${totalProfiles} co-ops, commons and community organisations across ${totalCountries} countries.

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
- geo: extract location names as simple place names only — "london", "berlin", "paris" — never composite strings like "England: London & SE". Resolve aliases: "UK" → ["England","Scotland","Wales","Northern Ireland"], "US"/"USA"/"america" → ["United States"], "deutschland" → ["Germany"], etc. Use the location names as they appear in the database.
- topic: extract the subject matter, ignoring location words and filler. "show me all the orgs you have in australia" → topic is "", geo is ["Australia"], queryType is "geo-only", showAll is true
- When the user says "show me all/everything" or "what have you got" with only a location, set showAll: true, queryType: "geo-only", topic: ""
- queryType: "geo-only" if geo but no topic, "topic-only" if topic but no geo, "geo+topic" if both
- Look at conversation history to resolve follow-ups: "in the USA?" after "renewable energy worldwide" → geo: ["United States"], topic: "renewable energy", queryType: "geo+topic"
- But detect NEW topics: "ok try open source projects" after energy discussion → topic: "open source", geo: [], queryType: "topic-only" (don't carry old geo)
- "is [X] in your data" or "do you have [X]" → search for X
- "show me all [X] you know about" → search for X
- "do you know about [X]" → search for X
- For chat responses: be brief and warm. One sentence. You are CoBot and you help people search a directory of co-ops, commons and community organisations. Guide them toward searching. No emoji.`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No API key — treat as search with original message
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

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[understand] No JSON found:', text);
      return res.json({ action: "search", geo: [], topic: message, queryType: "topic-only", showAll: false });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    res.json(parsed);
  } catch (err) {
    console.error("[understand] Error:", err.message);
    // On error, fall through as search with original message
    res.json({ action: "search", geo: [], topic: req.body.message, queryType: "topic-only", showAll: false });
  }
};
