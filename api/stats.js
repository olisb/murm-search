const { getStats } = require("./_stats");

module.exports = function handler(req, res) {
  res.json(getStats());
};
