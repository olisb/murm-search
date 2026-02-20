const Anthropic = require("@anthropic-ai/sdk");

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
