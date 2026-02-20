const Anthropic = require("@anthropic-ai/sdk");

const totalProfiles = 16885;
const totalCountries = 314;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

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
      system: `You are CoBot, a friendly search tool for the Murmurations network — a directory of ${totalProfiles.toLocaleString()} co-ops, commons and community organisations across ${totalCountries} countries. You help people find organisations by topic and location. Keep responses brief and warm. If someone greets you, say hi and tell them what you can help with. Guide them toward searching. Never use emoji. Never use markdown bold, bullet points, or lists. Talk in plain sentences. One sentence for casual chat. Don't explain what the Murmurations network is unless specifically asked. You ARE the search interface — never tell users to "visit the Murmurations website" or "search directly", they are already searching through you. Never say you "don't have access" to the data. Never claim an organisation is or isn't in the directory — you only see top results, not the full dataset.`,
      messages,
    });

    const text = message.content[0]?.text || "";
    res.json({ response: text });
  } catch (err) {
    console.error("[chat-conversational] Error:", err.message);
    res.status(500).json({ error: `Chat failed: ${err.message}` });
  }
};
