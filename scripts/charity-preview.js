const fs = require("fs");
const data = JSON.parse(fs.readFileSync("data/osm-charity_shops.json", "utf-8"));

// Type breakdown
const byType = {};
for (const p of data) {
  const t = (p.tags && p.tags[0]) || "unknown";
  byType[t] = (byType[t] || 0) + 1;
}
console.log(`Total: ${data.length} charity/second-hand/free shops\n`);
console.log("By type:");
for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t}: ${n}`);
}

// Country breakdown
const byCountry = {};
for (const p of data) {
  const c = p.country || "unknown";
  byCountry[c] = (byCountry[c] || 0) + 1;
}
const top = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log("\nTop 20 countries:");
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

// How many have real descriptions
const autoDesc = data.filter((p) => p.description && (p.description.includes("is a charity shop") || p.description.includes("is a second hand shop") || p.description.includes("is a free shop"))).length;
const withRealDesc = data.length - autoDesc;
console.log(`\nWith real description: ${withRealDesc} (${Math.round((withRealDesc / data.length) * 100)}%)`);
console.log(`Auto-generated desc: ${autoDesc}`);

// Random sample of 120
const shuffled = data.sort(() => Math.random() - 0.5).slice(0, 120);
const lines = shuffled.map((p, i) => {
  const loc = [p.locality, p.country].filter(Boolean).join(", ");
  const tag = (p.tags && p.tags[0]) || "?";
  return `${String(i + 1).padStart(3)}. [${tag}] ${p.name}  |${loc || "?"}|  ${p.primary_url}`;
}).join("\n");
fs.writeFileSync("data/charity-sample.txt", lines);
console.log("\n--- Sample of 120 ---\n");
console.log(lines);
