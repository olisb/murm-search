const fs = require("fs");
const data = JSON.parse(fs.readFileSync("data/osm-organic_shops.json", "utf-8"));

// Country breakdown
const byCountry = {};
for (const p of data) {
  const c = p.country || "unknown";
  byCountry[c] = (byCountry[c] || 0) + 1;
}
const top = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log(`Total: ${data.length} organic shops\n`);
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

// Detect potential chains — group by domain
const byDomain = {};
for (const p of data) {
  if (!p.primary_url) continue;
  try {
    const host = new URL(p.primary_url).hostname.replace(/^www\./, "");
    byDomain[host] = (byDomain[host] || 0) + 1;
  } catch {}
}
const chains = Object.entries(byDomain).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]);
console.log(`\n--- Potential chains (5+ locations sharing a domain) ---`);
for (const [domain, count] of chains) {
  // Find a sample name
  const sample = data.find(p => p.primary_url && p.primary_url.includes(domain));
  console.log(`  ${domain}: ${count} locations (e.g. "${sample?.name}")`);
}

// How many have real descriptions
const withRealDesc = data.filter((p) => p.description && !p.description.includes("is a organic")).length;
console.log(`\nWith real description: ${withRealDesc} (${Math.round((withRealDesc / data.length) * 100)}%)`);
console.log(`Auto-generated desc: ${data.length - withRealDesc}`);

// Random sample of 100
const shuffled = data.sort(() => Math.random() - 0.5).slice(0, 100);
const lines = shuffled.map((p, i) => {
  const loc = [p.locality, p.country].filter(Boolean).join(", ");
  return `${String(i + 1).padStart(3)}. ${p.name}  |${loc || "?"}|  ${p.primary_url}`;
}).join("\n");
fs.writeFileSync("data/organic-sample.txt", lines);
console.log("\n--- Random sample of 100 ---\n");
console.log(lines);
