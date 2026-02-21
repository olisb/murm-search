const fs = require("fs");
const path = require("path");

let _stats = null;

function getStats() {
  if (_stats) return _stats;

  try {
    const filePath = path.join(__dirname, "..", "public", "data", "profiles-meta.json");
    const profiles = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const countries = new Set(profiles.map((p) => p.country).filter(Boolean));
    _stats = { totalProfiles: profiles.length, totalCountries: countries.size };
  } catch {
    _stats = { totalProfiles: 21955, totalCountries: 130 };
  }

  return _stats;
}

module.exports = { getStats };
