require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json({ limit: "2mb" }));

// Load profile stats for system prompt
const PROFILES_PATH = path.join(__dirname, "..", "data", "profiles.json");
let totalProfiles = 0;
let totalCountries = 0;
let categoryCounts = "";
try {
  const allProfiles = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
  totalProfiles = allProfiles.length;
  // Count unique countries — split composites, deduplicate, filter noise
  const countrySet = new Set();
  const langDupes = new Set(["deutschland","germania","allemagne","duitsland","frankreich","francia","spanien","espana","españa","italia","italien","italië","nederland","niederlande","schweiz","suisse","svizzera","österreich","zweden","danmark","dänemark","belgien","belgique","norge","brasil","brasilien","brail","polen","kroatien","kenia","indien","bulgarien","griechenland","russland","tansania","bolivien","vereinigte staaten von amerika","verenigde staten","vereinigtes königreich","verenigd koninkrijk","perú"]);
  for (const p of allProfiles) {
    if (!p.country) continue;
    const segments = p.country.replace(/&amp;/g, "&").split(/[:|]/).map(s => s.trim().toLowerCase()).filter(s => s.length > 3);
    for (const s of segments) {
      if (langDupes.has(s)) continue;
      if (/[\u0400-\u04FF\u4E00-\u9FFF]/.test(s)) continue;
      if (s.includes("(")) continue;
      if (["borders","midlands","the north","south west","london & se","wales & borders"].includes(s)) continue;
      countrySet.add(s);
    }
  }
  totalCountries = countrySet.size;
  // Count profiles by category using tags
  const tagCounts = {};
  const TAG_CATEGORIES = {
    "nature reserve": "nature reserves",
    "farm shop": "farm shops",
    "ngo": "NGOs",
    "charity shop": "charity shops",
    "second hand shop": "second hand shops",
    "free shop": "free shops",
    "organic shop": "organic shops",
    "organic": "organic shops",
    "coworking": "coworking spaces",
    "hackerspace": "hackerspaces",
    "makerspace": "makerspaces",
    "cooperative": "cooperatives",
    "coop": "cooperatives",
    "repair cafe": "repair cafes",
    "zero waste": "zero waste shops",
    "fair trade": "fair trade shops",
  };
  for (const p of allProfiles) {
    for (const t of (p.tags || [])) {
      const cat = TAG_CATEGORIES[t];
      if (cat && !tagCounts[cat]) tagCounts[cat] = 0;
      if (cat) tagCounts[cat]++;
    }
  }
  categoryCounts = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", ");
  console.log(`  Loaded stats: ${totalProfiles} profiles, ${totalCountries} countries`);
} catch (err) {
  console.warn("  Could not load profile stats:", err.message);
}

// Static files (no caching during development)
app.use("/", express.static(path.join(__dirname, "..", "src"), { etag: false, lastModified: false, setHeaders: (res) => res.set("Cache-Control", "no-store") }));
app.use("/data", express.static(path.join(__dirname, "..", "data")));

// -------------------------------------------------------------------
// Search data — load embeddings + profiles into memory at startup
// -------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "..", "data");
const EMBED_DIM = 384;
const TOP_K_DISPLAY = 20;
const TOP_K_GEO_BROWSE = 50;
const TOP_K_LLM = 8;
const GEO_FILTER_MIN = 5;
const RELEVANCE_THRESHOLD = 0.35;

let profilesMeta = [];
let embInt8 = null;
let embScales = null;

try {
  console.log("  Loading search data...");
  profilesMeta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "profiles-meta.json"), "utf8"));
  embInt8 = new Int8Array(fs.readFileSync(path.join(DATA_DIR, "embeddings-int8.bin")).buffer);
  embScales = new Float32Array(fs.readFileSync(path.join(DATA_DIR, "embeddings-scales.bin")).buffer);
  console.log(`  Loaded ${profilesMeta.length} profiles, ${embInt8.length / EMBED_DIM} embedding vectors (Int8)`);
} catch (err) {
  console.warn("  Could not load search data:", err.message);
  console.warn("  Run: python scripts/quantize-embeddings.py");
}

// -------------------------------------------------------------------
// Geographic search utilities (ported from src/app.js)
// -------------------------------------------------------------------

const GEO_ALIASES = {
  uk: ["england", "scotland", "wales", "northern ireland", "united kingdom", "gb"],
  britain: ["england", "scotland", "wales", "united kingdom", "gb"],
  "united kingdom": ["england", "scotland", "wales", "northern ireland", "united kingdom", "gb"],
  england: ["england"], scotland: ["scotland"], wales: ["wales"],
  "northern ireland": ["northern ireland"],
  "east anglia": ["norfolk", "suffolk", "cambridgeshire", "east anglia"],
  "west country": ["devon", "cornwall", "somerset", "dorset"],
  "home counties": ["surrey", "kent", "essex", "hertfordshire", "buckinghamshire", "berkshire"],
  midlands: ["west midlands", "east midlands", "warwickshire", "staffordshire", "derbyshire", "nottinghamshire", "leicestershire"],
  "south east": ["surrey", "kent", "sussex", "hampshire"],
  "north west": ["lancashire", "cumbria", "merseyside", "greater manchester", "cheshire"],
  "north east": ["northumberland", "tyne and wear", "county durham"],
  "greater london": ["london"],
  us: ["united states", "us", "usa"], usa: ["united states", "us", "usa"],
  "united states": ["united states", "us", "usa"], america: ["united states", "us", "usa"],
  france: ["france", "fr", "frankreich"], frankreich: ["france", "fr", "frankreich"],
  germany: ["germany", "de", "deutschland"], deutschland: ["germany", "de", "deutschland"],
  spain: ["spain", "es", "españa", "espana"], "españa": ["spain", "es", "españa", "espana"], espana: ["spain", "es", "españa", "espana"],
  italy: ["italy", "it"], brazil: ["brazil", "br"], canada: ["canada", "ca"],
  australia: ["australia", "au"], india: ["india", "in"], japan: ["japan", "jp"],
  netherlands: ["netherlands", "nl"], belgium: ["belgium", "be"],
  austria: ["austria", "at", "österreich", "oesterreich"], "österreich": ["austria", "at", "österreich", "oesterreich"],
  switzerland: ["switzerland", "ch", "schweiz", "suisse", "svizzera"], schweiz: ["switzerland", "ch", "schweiz", "suisse", "svizzera"],
  sweden: ["sweden", "se"], portugal: ["portugal", "pt"], kenya: ["kenya", "ke"],
  ecuador: ["ecuador", "ec"], ireland: ["ireland", "ie"], "new zealand": ["new zealand", "nz"],
};

function splitLocationSegments(value) {
  return value.replace(/&amp;/g, "&").split(/[:|&|]/).map(s => s.trim().toLowerCase()).filter(s => s.length >= 2);
}

let knownLocations = null;

function buildLocationIndex() {
  knownLocations = new Set();
  for (const p of profilesMeta) {
    if (p.locality) splitLocationSegments(p.locality).forEach(s => knownLocations.add(s));
    if (p.region) splitLocationSegments(p.region).forEach(s => knownLocations.add(s));
    if (p.country) splitLocationSegments(p.country).forEach(s => knownLocations.add(s));
  }
}

// Build once at startup
if (profilesMeta.length > 0) buildLocationIndex();

// Build geo sample for LLM context
let geoSample = "";
function buildGeoSample() {
  const countries = new Set();
  const regionCounts = {};
  const cityCounts = {};
  for (const p of profilesMeta) {
    if (p.country) splitLocationSegments(p.country).forEach(s => countries.add(s));
    if (p.region) splitLocationSegments(p.region).forEach(s => regionCounts[s] = (regionCounts[s] || 0) + 1);
    if (p.locality) splitLocationSegments(p.locality).forEach(s => cityCounts[s] = (cityCounts[s] || 0) + 1);
  }
  const topRegions = Object.entries(regionCounts).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([name]) => name);
  const topCities = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([name]) => name);
  geoSample = `Countries: ${[...countries].sort().join(", ")}. Regions: ${topRegions.join(", ")}. Cities: ${topCities.join(", ")}`;
}
if (profilesMeta.length > 0) buildGeoSample();

function extractGeoTerms(query) {
  const q = query.toLowerCase().replace(/['']/g, "");
  const terms = [];
  const aliasKeys = Object.keys(GEO_ALIASES).sort((a, b) => b.length - a.length);
  const matched = new Set();
  for (const key of aliasKeys) {
    if (q.includes(key) && !matched.has(key)) {
      terms.push(...GEO_ALIASES[key]);
      key.split(/\s+/).forEach(w => matched.add(w));
      matched.add(key);
    }
  }
  if (!knownLocations) buildLocationIndex();
  const words = q.split(/\s+/).filter(w => w.length >= 3);
  for (const word of words) {
    if (terms.includes(word) || matched.has(word)) continue;
    if (knownLocations.has(word)) terms.push(word);
  }
  for (let i = 0; i < words.length - 1; i++) {
    const pair = words[i] + " " + words[i + 1];
    if (!terms.includes(pair) && knownLocations.has(pair)) terms.push(pair);
  }
  for (let i = 0; i < words.length - 2; i++) {
    const triple = words[i] + " " + words[i + 1] + " " + words[i + 2];
    if (!terms.includes(triple) && knownLocations.has(triple)) terms.push(triple);
  }
  return terms;
}

function profileMatchesGeo(profile, geoTerms) {
  const fields = [profile.country, profile.region, profile.locality].filter(Boolean).map(s => s.toLowerCase());
  for (const term of geoTerms) {
    for (const field of fields) {
      if (field.includes(term)) return true;
    }
  }
  return false;
}

const STOPWORDS = new Set([
  "the","and","for","are","but","not","you","all","can","has","her","was","one","our","out","his","how","its","may","who",
  "did","get","let","say","she","too","use","with","that","this","from","they","been","have","many","some","them","than","each",
  "make","like","into","over","such","here","what","about","which","when","there","their","will","would","could","should",
  "any","does","please","help","want","need","looking","much","got","your","every","most","these","those",
  "shall","might","just","also","very","really","quite","what's","whats",
  "show","find","search","list","give","tell","see","orgs","org","know","where",
  "everything","anything","things","places","stuff",
  "projects","organisations","organizations","groups","initiatives","based","near","nearby","around","related",
]);

function extractTopicWords(query, geoTerms) {
  const geoAliasWords = new Set();
  for (const [key, vals] of Object.entries(GEO_ALIASES)) {
    key.split(/\s+/).forEach(w => geoAliasWords.add(w));
    vals.forEach(v => v.split(/\s+/).forEach(w => geoAliasWords.add(w)));
  }
  if (geoTerms) {
    for (const t of geoTerms) t.split(/\s+/).forEach(w => geoAliasWords.add(w));
  }
  return query.toLowerCase().replace(/['']/g, "").split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w) && !geoAliasWords.has(w));
}

function topicKeywordBoost(profile, topicWords) {
  if (topicWords.length === 0) return 0;
  const text = [profile.name, profile.description, ...(profile.tags || [])].filter(Boolean).join(" ").toLowerCase();
  let matches = 0;
  for (const word of topicWords) {
    if (text.includes(word)) matches++;
  }
  return matches / topicWords.length;
}

// Int8 cosine similarity with dequantization
function cosineSimilarityInt8(queryVec, idx) {
  const offset = idx * EMBED_DIM;
  const scaleOffset = idx * 2;
  const mn = embScales[scaleOffset];
  const mx = embScales[scaleOffset + 1];
  const range = mx - mn || 1;
  const scale = range / 255;
  let dot = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    const dequant = (embInt8[offset + i] + 128) * scale + mn;
    dot += queryVec[i] * dequant;
  }
  return dot;
}

function searchProfilesServer(queryEmbedding, query, topK, llmParams) {
  let geoTerms, topicWords, queryType;

  if (llmParams && llmParams.geo) {
    geoTerms = llmParams.geo.map(g => g.toLowerCase());
    topicWords = llmParams.topic ? extractTopicWords(llmParams.topic, []) : [];
    queryType = llmParams.queryType || (geoTerms.length > 0 && topicWords.length > 0 ? "geo+topic" : geoTerms.length > 0 ? "geo-only" : "topic-only");
  } else {
    geoTerms = extractGeoTerms(query);
    topicWords = extractTopicWords(query, geoTerms);
    const hasTopic = topicWords.length > 0;
    queryType = geoTerms.length > 0 && !hasTopic ? "geo-only" : geoTerms.length > 0 && hasTopic ? "geo+topic" : "topic-only";
  }

  let geoNote = null;
  const hasTopicWords = topicWords.length > 0;

  function scoreProfile(idx, geoMultiplier) {
    const semantic = queryEmbedding ? cosineSimilarityInt8(queryEmbedding, idx) : 0;
    const kwBoost = topicKeywordBoost(profilesMeta[idx], topicWords);
    const penaltyVal = penalties[profilesMeta[idx].profile_url] ?? 1;
    const combined = semantic * geoMultiplier * (1 + kwBoost * 1.0) * penaltyVal;
    return {
      idx,
      profile: profilesMeta[idx],
      score: combined,
      rawSemantic: Math.min(1, semantic * (1 + kwBoost * 1.0)),
      kwBoost,
    };
  }

  if (geoTerms.length > 0) {
    const geoMatchIndices = [];
    for (let i = 0; i < profilesMeta.length; i++) {
      if (profileMatchesGeo(profilesMeta[i], geoTerms)) geoMatchIndices.push(i);
    }

    if (geoMatchIndices.length >= GEO_FILTER_MIN) {
      if (!hasTopicWords) {
        const results = geoMatchIndices.map(idx => {
          const p = profilesMeta[idx];
          const descLen = (p.description || "").length;
          return { idx, profile: p, score: descLen, rawSemantic: 0, kwBoost: 0 };
        });
        results.sort((a, b) => b.score - a.score);
        const totalGeoMatches = results.length;
        return { results: results.slice(0, TOP_K_GEO_BROWSE), geoNote, geoTerms, topicWords, queryType, totalGeoMatches };
      }

      const scored = geoMatchIndices.map(idx => scoreProfile(idx, 1));
      scored.sort((a, b) => b.score - a.score);
      const topResults = scored.slice(0, topK);
      const filtered = topResults.filter(r => r.rawSemantic >= RELEVANCE_THRESHOLD && r.kwBoost > 0);

      if (filtered.length === 0) {
        const fallbackResults = geoMatchIndices.map(idx => {
          const p = profilesMeta[idx];
          const descLen = (p.description || "").length;
          return { idx, profile: p, score: descLen, rawSemantic: 0, kwBoost: 0 };
        });
        fallbackResults.sort((a, b) => b.score - a.score);
        const totalGeoMatches = fallbackResults.length;
        return { results: fallbackResults.slice(0, TOP_K_GEO_BROWSE), geoNote, geoTerms, topicWords, queryType: "geo+topic-fallback", totalGeoMatches, originalTopicWords: topicWords };
      }

      return { results: filtered, geoNote, geoTerms, topicWords, queryType };
    }

    const triedLocations = [...new Set(geoTerms)].map(t => t.charAt(0).toUpperCase() + t.slice(1));
    geoNote = `No results found matching that location. Searched: ${triedLocations.join(", ")}.`;
    return { results: [], geoNote, geoTerms, topicWords, queryType };
  }

  // No geo terms — pure topic search
  const allScored = [];
  for (let i = 0; i < profilesMeta.length; i++) {
    allScored.push(scoreProfile(i, 1));
  }
  allScored.sort((a, b) => b.score - a.score);

  const topResults = allScored.slice(0, topK);
  const filtered = topResults.filter(r =>
    r.rawSemantic >= RELEVANCE_THRESHOLD && (!hasTopicWords || r.kwBoost > 0 || r.rawSemantic >= 0.5)
  );

  let totalTopicMatches = null;
  if (hasTopicWords) {
    totalTopicMatches = 0;
    for (let i = 0; i < profilesMeta.length; i++) {
      if (topicKeywordBoost(profilesMeta[i], topicWords) > 0) totalTopicMatches++;
    }
  }

  return { results: filtered, geoNote, geoTerms, topicWords, queryType, totalTopicMatches };
}

// -------------------------------------------------------------------
// Search endpoint
// -------------------------------------------------------------------
app.post("/api/search", async (req, res) => {
  try {
    const { query, geo, topic, queryType, showAll } = req.body;
    if (!query && !topic && (!geo || geo.length === 0)) {
      return res.status(400).json({ error: "Missing query" });
    }

    // Build embedding if we have a topic
    let queryEmbedding = null;
    const searchTopic = topic || query || "";
    const llmParams = (geo || topic || queryType) ? { geo: geo || [], topic: topic || "", queryType: queryType || null, showAll: showAll || false } : null;
    const effectiveQueryType = llmParams?.queryType || "topic-only";

    if (searchTopic && effectiveQueryType !== "geo-only") {
      const expanded = "Organisation or project related to: " + searchTopic;
      const embed = await getEmbedder();
      const output = await embed(expanded, { pooling: "mean", normalize: true });
      queryEmbedding = Array.from(output.data);
    }

    const searchResult = searchProfilesServer(queryEmbedding, query || searchTopic, TOP_K_DISPLAY, llmParams);

    // Strip internal idx from results, add _relevance
    const results = searchResult.results.map(r => ({
      ...r.profile,
      _relevance: r.rawSemantic > 0 ? Math.round(r.rawSemantic * 100) : null,
      _idx: r.idx,
    }));

    res.json({
      results,
      totalResults: searchResult.totalGeoMatches || searchResult.totalTopicMatches || results.length,
      geoNote: searchResult.geoNote,
      queryType: searchResult.queryType,
      geoTerms: searchResult.geoTerms,
      topicWords: searchResult.topicWords,
    });
  } catch (err) {
    console.error("[search] Error:", err.message);
    res.status(500).json({ error: `Search failed: ${err.message}` });
  }
});

// -------------------------------------------------------------------
// Stats endpoint
// -------------------------------------------------------------------
app.get("/api/stats", (req, res) => {
  res.json({ totalProfiles, totalCountries });
});

// -------------------------------------------------------------------
// Reports
// -------------------------------------------------------------------
const REPORTS_PATH = path.join(__dirname, "..", "data", "reports.json");

function loadReports() {
  try {
    if (fs.existsSync(REPORTS_PATH)) {
      return JSON.parse(fs.readFileSync(REPORTS_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("[reports] Failed to load:", err.message);
  }
  return [];
}

function saveReports(reports) {
  fs.mkdirSync(path.dirname(REPORTS_PATH), { recursive: true });
  fs.writeFileSync(REPORTS_PATH, JSON.stringify(reports, null, 2));
}

let reports = loadReports();
console.log(`[reports] Loaded ${reports.length} existing reports`);

// Module-level penalties map used by search
let penalties = {};

// Compute penalty map: profile_url -> multiplier
function computePenalties() {
  const penaltyMap = {};
  const deadLinks = {};     // profile_url -> count
  const irrelevantQs = {};  // profile_url -> Set of unique queries

  for (const r of reports) {
    if (r.report_type === "dead_link") {
      deadLinks[r.profile_url] = (deadLinks[r.profile_url] || 0) + 1;
    } else if (r.report_type === "irrelevant") {
      if (!irrelevantQs[r.profile_url]) irrelevantQs[r.profile_url] = new Set();
      irrelevantQs[r.profile_url].add(r.query || "");
    }
  }

  for (const [url, count] of Object.entries(deadLinks)) {
    penaltyMap[url] = 0.1; // dead links get buried
  }

  for (const [url, queries] of Object.entries(irrelevantQs)) {
    const factor = Math.max(0.5, Math.pow(0.9, queries.size));
    penaltyMap[url] = Math.min(penaltyMap[url] ?? 1, factor);
  }

  return penaltyMap;
}

// Initialize penalties at startup
penalties = computePenalties();

app.get("/api/reports", (req, res) => {
  res.json(reports);
});

app.get("/api/penalties", (req, res) => {
  res.json(computePenalties());
});

app.post("/api/report", (req, res) => {
  const { profile_url, profile_name, primary_url, report_type, query, message } = req.body;
  if (!profile_url || !report_type) {
    return res.status(400).json({ error: "Missing profile_url or report_type" });
  }

  const report = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    profile_url,
    profile_name: profile_name || null,
    primary_url: primary_url || null,
    report_type,
    query: query || null,
    message: message || null,
    timestamp: new Date().toISOString(),
  };

  reports.push(report);
  saveReports(reports);
  penalties = computePenalties();

  res.json({ ok: true, id: report.id });
});

app.delete("/api/reports/:id", (req, res) => {
  const idx = reports.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  reports.splice(idx, 1);
  saveReports(reports);
  penalties = computePenalties();
  res.json({ ok: true });
});

// -------------------------------------------------------------------
// Admin page
// -------------------------------------------------------------------
app.get("/admin", (req, res) => {
  const deadCount = reports.filter((r) => r.report_type === "dead_link").length;
  const irrelCount = reports.filter((r) => r.report_type === "irrelevant").length;
  const feedbackCount = reports.filter((r) => r.report_type === "feedback").length;

  const rows = [...reports]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((r) => `
      <tr data-id="${r.id}">
        <td>${r.timestamp.slice(0, 16).replace("T", " ")}</td>
        <td><span class="rtype rtype-${r.report_type}">${r.report_type}</span></td>
        <td>${esc(r.profile_name || "—")}</td>
        <td>${r.primary_url ? `<a href="${esc(r.primary_url)}" target="_blank">${esc(r.primary_url)}</a>` : "—"}</td>
        <td>${esc(r.query || "—")}</td>
        <td>${esc(r.message || "—")}</td>
        <td><button onclick="dismiss('${r.id}', this)">Dismiss</button></td>
      </tr>
    `)
    .join("");

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CoBot — Admin Reports</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1210; color: #d4ddd6; padding: 24px; }
  h1 { font-size: 22px; margin-bottom: 16px; }
  h1 span { color: #4ecb71; }
  .summary { display: flex; gap: 16px; margin-bottom: 20px; }
  .stat { padding: 12px 20px; background: #171d19; border: 1px solid #2a3630; border-radius: 8px; font-size: 14px; }
  .stat strong { color: #4ecb71; font-size: 20px; display: block; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; background: #171d19; border-bottom: 2px solid #2a3630; color: #7a8f80; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; }
  th:hover { color: #4ecb71; }
  td { padding: 8px 10px; border-bottom: 1px solid #1c2420; vertical-align: top; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tr:hover td { background: #1c2420; }
  a { color: #4ecb71; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .rtype { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .rtype-dead_link { background: #3a1a1a; color: #e87070; }
  .rtype-irrelevant { background: #3a3010; color: #d4a940; }
  .rtype-feedback { background: #1a2e22; color: #6bc88a; }
  button { padding: 4px 10px; background: #1c2420; border: 1px solid #2a3630; border-radius: 4px; color: #7a8f80; cursor: pointer; font-size: 12px; }
  button:hover { color: #e87070; border-color: #e87070; }
  .empty { text-align: center; padding: 40px; color: #4e6055; }
  .back { display: inline-block; margin-bottom: 16px; color: #4ecb71; text-decoration: none; font-size: 13px; }
</style>
</head>
<body>
  <a href="/" class="back">← Back to search</a>
  <h1>Co<span>Bot</span> reports</h1>
  <div class="summary">
    <div class="stat"><strong>${deadCount}</strong>Dead links</div>
    <div class="stat"><strong>${irrelCount}</strong>Irrelevant flags</div>
    <div class="stat"><strong>${feedbackCount}</strong>Feedback</div>
    <div class="stat"><strong>${reports.length}</strong>Total</div>
  </div>
  ${reports.length === 0
    ? '<div class="empty">No reports yet.</div>'
    : `<table>
    <thead><tr>
      <th>Time</th><th>Type</th><th>Profile</th><th>URL</th><th>Query</th><th>Message</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
  <script>
    async function dismiss(id, btn) {
      if (!confirm("Dismiss this report?")) return;
      const res = await fetch("/api/reports/" + id, { method: "DELETE" });
      if (res.ok) btn.closest("tr").remove();
    }
    // Column sorting
    document.querySelectorAll("th").forEach((th, col) => {
      th.addEventListener("click", () => {
        const tbody = document.querySelector("tbody");
        const rows = [...tbody.querySelectorAll("tr")];
        const dir = th.dataset.dir === "asc" ? "desc" : "asc";
        th.dataset.dir = dir;
        rows.sort((a, b) => {
          const at = a.children[col]?.textContent || "";
          const bt = b.children[col]?.textContent || "";
          return dir === "asc" ? at.localeCompare(bt) : bt.localeCompare(at);
        });
        rows.forEach(r => tbody.appendChild(r));
      });
    });
  </script>
</body>
</html>`);
});

// -------------------------------------------------------------------
// Query embedding via Transformers.js (loads model on first request)
// -------------------------------------------------------------------
let pipeline = null;
let embedder = null;

async function getEmbedder() {
  if (embedder) return embedder;
  const { pipeline: pipelineFn } = await import("@xenova/transformers");
  pipeline = pipelineFn;
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  return embedder;
}

app.post("/api/embed", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing query string" });
    }

    const embed = await getEmbedder();
    const output = await embed(query, { pooling: "mean", normalize: true });
    const vector = Array.from(output.data);

    res.json({ embedding: vector });
  } catch (err) {
    console.error("Embed error:", err);
    res.status(500).json({ error: "Embedding failed" });
  }
});

// -------------------------------------------------------------------
// Chat endpoint
// -------------------------------------------------------------------
function buildSystemPrompt() {
  return `You are CoBot, a search tool that combines data from the Murmurations network and OpenStreetMap to provide a directory of ${totalProfiles} profiles across ${totalCountries} countries. The directory includes: ${categoryCounts}, plus co-ops, commons, community organisations and more from the Murmurations network.

The user searches by talking to you. Their messages trigger searches automatically and you see the results below. You ARE the search tool — never tell users to "visit the Murmurations website" or "search directly." Never say you "don't have access" to data. NEVER refer users to Google, Google Maps, or any external search engine. If you can't find what they want, suggest a related search using terms you do have data for.

The user sees result cards and a map below your message — don't repeat what's visible there.

STRICT LIMIT: 30 words or fewer. One or two short sentences only. Plain text. No emoji. No markdown. Talk like a knowledgeable friend.

Add value the cards can't: spot patterns, note gaps, suggest better searches. If results don't match, say so and suggest different terms. When suggesting a search, wrap it in quotes like "renewable energy cooperatives" so users can click it.

Never claim an organisation is or isn't in the directory — you only see top results, not the full dataset. If results are empty, say you couldn't find matches, not that things don't exist here.`;
}


app.post("/api/chat", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(501).json({ error: "No ANTHROPIC_API_KEY configured — chat mode requires an API key. Switch to Search mode." });
  }

  try {
    const { query, geo, topic, queryType: reqQueryType, showAll, geoNote: reqGeoNote, history = [] } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing query" });
    }

    // Run search internally to get top results
    let queryEmbedding = null;
    const searchTopic = topic || query;
    const llmParams = { geo: geo || [], topic: topic || "", queryType: reqQueryType || null, showAll: showAll || false };
    const effectiveQueryType = llmParams.queryType || "topic-only";

    if (searchTopic && effectiveQueryType !== "geo-only") {
      const expanded = "Organisation or project related to: " + searchTopic;
      const embed = await getEmbedder();
      const output = await embed(expanded, { pooling: "mean", normalize: true });
      queryEmbedding = Array.from(output.data);
    }

    const searchResult = searchProfilesServer(queryEmbedding, query, TOP_K_DISPLAY, llmParams);
    const profileList = searchResult.results.slice(0, TOP_K_LLM).map(r => ({
      ...r.profile,
      _relevance: r.rawSemantic > 0 ? Math.round(r.rawSemantic * 100) : null,
    }));

    const total = searchResult.totalGeoMatches || searchResult.totalTopicMatches || searchResult.results.length;
    const geoNote = reqGeoNote || searchResult.geoNote;
    const geoTerms = searchResult.geoTerms || [];
    const topicKeywords = searchResult.topicWords || [];

    const geoStr = geoTerms.length > 0 ? geoTerms.join(", ") : "none";
    const topicStr = topicKeywords.length > 0 ? topicKeywords.join(", ") : "none";

    // Build profile context
    const profileContext = profileList
      .slice(0, 8)
      .map((p, i) => {
        const loc = [p.locality, p.region, p.country].filter(Boolean).join(", ");
        const tags = (p.tags || []).join(", ");
        const url = p.primary_url || "no website";
        const desc = (p.description || "No description available.").slice(0, 400);
        const relevance = p._relevance != null ? `${p._relevance}%` : "n/a";
        return `${i + 1}. (relevance: ${relevance}) ${p.name}\n   Location: ${loc || "unknown"}\n   Description: ${desc}\n   Tags: ${tags || "none"}\n   Website: ${url}`;
      })
      .join("\n\n");

    const metadata = `Search metadata:
- Total matches: ${total} (showing top ${profileList.length})
- Query type: ${searchResult.queryType || reqQueryType || "unknown"}
- Location filter: ${geoStr}
- Topic filter: ${topicStr}${geoNote ? `\n- Note: ${geoNote}` : ""}`;

    const userMessage = `User query: "${query}"\n\n${metadata}\n\n${profileContext}`;

    // Build messages with conversation history
    const messages = [];
    for (const msg of history.slice(-10)) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: "user", content: userMessage });

    const systemPrompt = buildSystemPrompt();
    const client = new Anthropic();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = client.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 120,
      system: systemPrompt,
      messages,
    });

    stream.on("text", (text) => {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });

    stream.on("end", () => {
      res.write("data: [DONE]\n\n");
      res.end();
    });

    stream.on("error", (err) => {
      console.error("[chat] Stream error:", err.message);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });
  } catch (err) {
    console.error("[chat] Error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: `Chat failed: ${err.message}` });
    }
  }
});

// -------------------------------------------------------------------
// Query understanding (single LLM call replaces classifier + rewriter)
// -------------------------------------------------------------------
const UNDERSTAND_PROMPT = `You are the query understanding layer for CoBot, a search tool combining Murmurations and OpenStreetMap data — a directory of ${totalProfiles} co-ops, commons, community organisations, hackerspaces, makerspaces, coworking spaces, repair cafes, zero waste, fair trade, charity and farm shops, organic shops, nature reserves and NGOs across ${totalCountries} countries.

Given the user's message and conversation history, determine what they want and return ONLY a JSON object.

Return this JSON structure:
{
  "action": "search" | "chat",
  "geo": ["location1"] or [],
  "topic": "search terms" or "",
  "queryType": "geo-only" | "topic-only" | "geo+topic",
  "showAll": true | false,
  "chatResponse": "only if action is chat, otherwise omit"
}

Rules:
- action is "search" for ANY message that mentions a topic, category, type of org, or location. This tool exists to search. Default to search.
- action is "chat" ONLY for pure greetings ("hi"), meta-questions about the tool ("what is this", "how does this work"), or feedback ("thanks", "cool")
- NEVER set action to "chat" when the message contains a searchable noun
- geo: extract location names as simple place names only — "london", "berlin", "paris" — never composite strings like "England: London & SE". Resolve aliases: "UK" → ["England","Scotland","Wales","Northern Ireland"], "US"/"USA"/"america" → ["United States"], "deutschland" → ["Germany"], etc. Use the location names as they appear in the database.
- topic: extract the subject matter, ignoring location words and filler. "show me all the orgs you have in australia" → topic is "", geo is ["Australia"], queryType is "geo-only", showAll is true
- When the user says "show me all/everything" or "what have you got" with only a location, set showAll: true, queryType: "geo-only", topic: ""
- queryType: "geo-only" if geo but no topic, "topic-only" if topic but no geo, "geo+topic" if both
- Look at conversation history to resolve follow-ups: "in the USA?" after "renewable energy worldwide" → geo: ["United States"], topic: "renewable energy", queryType: "geo+topic"
- But detect NEW topics: "ok try open source projects" after energy discussion → topic: "open source", geo: [], queryType: "topic-only" (don't carry old geo)
- "is [X] in your data" or "do you have [X]" → search for X
- "show me all [X] you know about" → search for X
- "do you know about [X]" → search for X
- For chat responses: be brief and warm. One sentence. You are CoBot and you help people search a directory of co-ops, commons, community organisations, coworking spaces, repair cafes, zero waste, fair trade, charity and farm shops, nature reserves and NGOs. Guide them toward searching. No emoji. When suggesting a search, wrap it in quotes like "renewable energy cooperatives" so users can click it.`;

app.post("/api/understand", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.json({ action: "search", geo: [], topic: req.body.message, queryType: "topic-only", showAll: false });
  }

  try {
    const { message, history = [] } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing message" });
    }

    const locationContext = geoSample
      ? `\n\nKnown locations in the database (sample):\n${geoSample}`
      : "";

    const messages = [];
    for (const msg of history.slice(-6)) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: "user", content: message });

    const client = new Anthropic();
    const result = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: UNDERSTAND_PROMPT + locationContext,
      messages,
    });

    const text = (result.content[0]?.text || "").trim();
    console.log('[understand]', { message, response: text, historyLength: messages.length });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[understand] No JSON found:', text);
      return res.json({ action: "search", geo: [], topic: message, queryType: "topic-only", showAll: false });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    res.json(parsed);
  } catch (err) {
    console.error("[understand] Error:", err.message);
    res.json({ action: "search", geo: [], topic: req.body.message, queryType: "topic-only", showAll: false });
  }
});

// -------------------------------------------------------------------
// Query rewriter + classifier (legacy, kept for backward compat)
// -------------------------------------------------------------------
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

app.post("/api/rewrite", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No API key — just pass through the query as-is
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
    // On error, fall through with original query
    res.json({ query: req.body.query, isChat: false });
  }
});

// -------------------------------------------------------------------
// Conversational (non-search) chat
// -------------------------------------------------------------------
app.post("/api/chat-conversational", async (req, res) => {
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
      system: `You are CoBot, a friendly search tool combining Murmurations and OpenStreetMap data — a directory of ${totalProfiles.toLocaleString()} co-ops, commons, community organisations, hackerspaces, makerspaces, coworking spaces, repair cafes, zero waste, fair trade, charity and farm shops across ${totalCountries} countries. You help people find organisations by topic and location. Keep responses brief and warm. If someone greets you, say hi and tell them what you can help with. Guide them toward searching. Never use emoji. Never use markdown bold, bullet points, or lists. Talk in plain sentences. One sentence for casual chat. Don't explain what the Murmurations network is unless specifically asked. You ARE the search interface — never tell users to "visit the Murmurations website" or "search directly", they are already searching through you. Never say you "don't have access" to the data. Never claim an organisation is or isn't in the directory — you only see top results, not the full dataset. When suggesting a search, wrap it in quotes like "renewable energy cooperatives" so users can click it.`,
      messages,
    });

    const text = message.content[0]?.text || "";
    res.json({ response: text });
  } catch (err) {
    console.error("[chat-conversational] Error:", err.message);
    res.status(500).json({ error: `Chat failed: ${err.message}` });
  }
});

// -------------------------------------------------------------------
// Check if chat is available (API key configured)
// -------------------------------------------------------------------
app.get("/api/chat-available", (req, res) => {
  res.json({ available: !!process.env.ANTHROPIC_API_KEY });
});

// -------------------------------------------------------------------
// Add profile from URL
// -------------------------------------------------------------------
const USER_PROFILES_PATH = path.join(__dirname, "..", "data", "user-profiles.json");

function loadUserProfiles() {
  try {
    if (fs.existsSync(USER_PROFILES_PATH)) {
      return JSON.parse(fs.readFileSync(USER_PROFILES_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("[user-profiles] Failed to load:", err.message);
  }
  return [];
}

function saveUserProfiles(entries) {
  fs.mkdirSync(path.dirname(USER_PROFILES_PATH), { recursive: true });
  fs.writeFileSync(USER_PROFILES_PATH, JSON.stringify(entries, null, 2));
}

let userProfiles = loadUserProfiles();
console.log(`[user-profiles] Loaded ${userProfiles.length} existing entries`);

app.post("/api/add-profile", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Missing profile URL" });
    }

    // Validate URL format
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL format" });
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "URL must be http or https" });
    }

    // Fetch the profile JSON
    let profileData;
    try {
      const fetchRes = await fetch(url);
      if (!fetchRes.ok) {
        return res.status(400).json({ error: `Could not fetch profile: HTTP ${fetchRes.status}` });
      }
      profileData = await fetchRes.json();
    } catch (err) {
      return res.status(400).json({ error: `Could not fetch profile: ${err.message}` });
    }

    // Normalize fields to match our schema
    const geo = profileData.geolocation || {};
    const tags = profileData.tags || profileData.keywords || [];
    const profile = {
      profile_url: url,
      name: profileData.name || profileData.title || "Unknown",
      description: profileData.description || profileData.mission || null,
      latitude: geo.lat != null ? Number(geo.lat) : (profileData.latitude != null ? Number(profileData.latitude) : null),
      longitude: geo.lon != null ? Number(geo.lon) : (profileData.longitude != null ? Number(profileData.longitude) : null),
      locality: profileData.locality || null,
      region: profileData.region || null,
      country: profileData.country_name || profileData.country || null,
      tags: Array.isArray(tags) ? tags : [],
      primary_url: profileData.primary_url || profileData.url || null,
      image: profileData.image || null,
      source: "user-submitted",
    };

    // Generate embedding
    const embeddingText = `Organisation or project related to: ${profile.name}. ${profile.description || ""}. Tags: ${profile.tags.join(", ")}`;
    const embed = await getEmbedder();
    const output = await embed(embeddingText, { pooling: "mean", normalize: true });
    const embedding = Array.from(output.data);

    // Deduplicate by profile_url
    const existingIdx = userProfiles.findIndex((e) => e.profile.profile_url === url);
    if (existingIdx >= 0) {
      userProfiles[existingIdx] = { profile, embedding };
    } else {
      userProfiles.push({ profile, embedding });
    }

    saveUserProfiles(userProfiles);
    console.log(`[user-profiles] ${existingIdx >= 0 ? "Updated" : "Added"}: ${profile.name}`);

    res.json({ ok: true, profile });
  } catch (err) {
    console.error("[add-profile] Error:", err);
    res.status(500).json({ error: `Failed to add profile: ${err.message}` });
  }
});

// -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  CoBot running at http://localhost:${PORT}`);
  console.log(`  Admin panel: http://localhost:${PORT}/admin`);
  console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "set" : "NOT SET"}\n`);
});
