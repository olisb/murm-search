const fs = require("fs");
const data = JSON.parse(fs.readFileSync("data/osm-marketplaces.json", "utf-8"));

// Country breakdown
const byCountry = {};
for (const p of data) {
  const c = p.country || "unknown";
  byCountry[c] = (byCountry[c] || 0) + 1;
}
const top = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log(`Total: ${data.length} marketplaces\n`);
console.log("Top 20 countries:");
for (const [c, n] of top) console.log(`  ${c}: ${n}`);

// Dedup preview
const existing = JSON.parse(fs.readFileSync("data/profiles.json", "utf-8"));
const existingUrls = new Set();
for (const p of existing) {
  if (p.primary_url) {
    existingUrls.add(p.primary_url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, ""));
  }
}
let dupes = 0;
for (const p of data) {
  if (!p.primary_url) continue;
  const norm = p.primary_url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  if (existingUrls.has(norm)) dupes++;
}
console.log(`\nAlready in dataset: ${dupes}`);
console.log(`New (before URL check): ${data.length - dupes}`);

// Detect potential chains
const byDomain = {};
for (const p of data) {
  if (!p.primary_url) continue;
  try {
    const host = new URL(p.primary_url).hostname.replace(/^www\./, "");
    byDomain[host] = (byDomain[host] || 0) + 1;
  } catch {}
}
const chains = Object.entries(byDomain).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
console.log(`\n--- Domains with 3+ locations ---`);
for (const [domain, count] of chains) {
  const sample = data.find(p => p.primary_url && p.primary_url.includes(domain));
  console.log(`  ${domain}: ${count} (e.g. "${sample?.name}")`);
}

// Name patterns - what kinds of marketplaces are these?
const namePatterns = {};
const patterns = [
  [/farmers?.?market/i, "farmers market"],
  [/flea.?market/i, "flea market"],
  [/christmas|weihnacht|noël/i, "christmas market"],
  [/antique|antik/i, "antiques"],
  [/craft/i, "craft market"],
  [/night.?market/i, "night market"],
  [/fish/i, "fish market"],
  [/food/i, "food market"],
  [/marché|mercado|mercato|markt/i, "generic market (non-English)"],
  [/mall|shopping.?cent|plaza/i, "shopping mall/center"],
  [/supermarket|grocery/i, "supermarket/grocery"],
];
for (const p of data) {
  const n = p.name || "";
  let matched = false;
  for (const [rx, label] of patterns) {
    if (rx.test(n)) {
      namePatterns[label] = (namePatterns[label] || 0) + 1;
      matched = true;
      break;
    }
  }
  if (!matched) namePatterns["other"] = (namePatterns["other"] || 0) + 1;
}
console.log(`\n--- Name patterns ---`);
for (const [label, count] of Object.entries(namePatterns).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${label}: ${count}`);
}

// Random sample of 120
const shuffled = data.sort(() => Math.random() - 0.5).slice(0, 120);
const lines = shuffled.map((p, i) => {
  const loc = [p.locality, p.country].filter(Boolean).join(", ");
  return `${String(i + 1).padStart(3)}. ${p.name}  |${loc || "?"}|  ${p.primary_url}`;
}).join("\n");
fs.writeFileSync("data/marketplace-sample.txt", lines);
console.log("\n--- Random sample of 120 ---\n");
console.log(lines);
