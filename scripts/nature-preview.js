const fs = require("fs");
const data = JSON.parse(fs.readFileSync("data/osm-nature_reserves.json", "utf-8"));

// Country breakdown
const byCountry = {};
for (const p of data) {
  const c = p.country || "unknown";
  byCountry[c] = (byCountry[c] || 0) + 1;
}
const top = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log(`Total: ${data.length} nature reserves\n`);
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

// How many have real descriptions
const withRealDesc = data.filter((p) => p.description && !p.description.includes("is a nature reserve")).length;
console.log(`\nWith real description: ${withRealDesc} (${Math.round((withRealDesc / data.length) * 100)}%)`);
console.log(`Auto-generated desc: ${data.length - withRealDesc}`);

// How many have coordinates
const withCoords = data.filter(p => p.latitude && p.longitude).length;
console.log(`With coordinates: ${withCoords} (${Math.round((withCoords / data.length) * 100)}%)`);

// Random sample of 100
const shuffled = data.sort(() => Math.random() - 0.5).slice(0, 100);
const lines = shuffled.map((p, i) => {
  const loc = [p.locality, p.country].filter(Boolean).join(", ");
  return `${String(i + 1).padStart(3)}. ${p.name}  |${loc || "?"}|  ${p.primary_url}`;
}).join("\n");
fs.writeFileSync("data/nature-sample.txt", lines);
console.log("\n--- Sample of 100 ---\n");
console.log(lines);
