const Anthropic = require("@anthropic-ai/sdk");

const REWRITE_PROMPT = `You are a query rewriter for a directory search tool. The user is having a conversation about finding organisations.

Given the conversation history and the user's latest message, output ONLY the full search query that captures what they're actually looking for. No explanation, just the search terms.

Examples:
- History: user searched "renewable energy" → user says "any in cambridge" → Output: "renewable energy cambridge"
- History: user searched "co-ops in scotland" → user says "what about housing?" → Output: "housing co-ops in scotland"
- History: none → user says "solar panels france" → Output: "solar panels france"
- History: user searched "food co-ops london" → user says "how about brighton" → Output: "food co-ops brighton"
- If the message is general chat (greetings, questions about the tool, not a search): Output exactly NOT_A_SEARCH`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
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
    res.json({ query: req.body.query, isChat: false });
  }
};
