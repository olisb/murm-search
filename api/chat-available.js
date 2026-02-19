module.exports = async function handler(req, res) {
  res.json({ available: !!process.env.ANTHROPIC_API_KEY });
};
