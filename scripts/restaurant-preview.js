const fs = require("fs");

for (const file of ["osm-vegetarian_restaurants.json", "osm-vegan_restaurants.json"]) {
  const filepath = `data/${file}`;
  if (!fs.existsSync(filepath)) { console.log(`${file}: not found, skipping`); continue; }

  const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
  const label = file.replace("osm-", "").replace(".json", "");
  console.log(`\n=== ${label} (${data.length} total) ===\n`);

  // Country breakdown
  const byCountry = {};
  for (const p of data) {
    const c = p.country || "unknown";
    byCountry[c] = (byCountry[c] || 0) + 1;
  }
  const top = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log("Top countries:");
  for (const [c, n] of top) console.log(`  ${c}: ${n}`);

  // Chain detection by domain
  const byDomain = {};
  for (const p of data) {
    if (!p.primary_url) continue;
    try {
      const host = new URL(p.primary_url).hostname.replace(/^www\./, "");
      byDomain[host] = (byDomain[host] || 0) + 1;
    } catch {}
  }
  const chains = Object.entries(byDomain).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  console.log(`\n--- Domains with 3+ locations (potential chains) ---`);
  if (chains.length === 0) {
    console.log("  None found");
  } else {
    for (const [domain, count] of chains) {
      const sample = data.find(p => p.primary_url && p.primary_url.includes(domain));
      console.log(`  ${domain}: ${count} (e.g. "${sample?.name}")`);
    }
  }

  // Domains with 2 locations
  const duos = Object.entries(byDomain).filter(([, n]) => n === 2).sort((a, b) => b[1] - a[1]);
  if (duos.length > 0) {
    console.log(`\n--- Domains with 2 locations ---`);
    for (const [domain, count] of duos.slice(0, 20)) {
      const sample = data.find(p => p.primary_url && p.primary_url.includes(domain));
      console.log(`  ${domain}: ${count} (e.g. "${sample?.name}")`);
    }
  }

  // Random sample
  const shuffled = [...data].sort(() => Math.random() - 0.5).slice(0, 30);
  console.log(`\n--- Random sample of 30 ---`);
  for (const [i, p] of shuffled.entries()) {
    const loc = [p.locality, p.country].filter(Boolean).join(", ");
    console.log(`  ${String(i + 1).padStart(2)}. ${p.name}  |${loc || "?"}|  ${p.primary_url}`);
  }
}
