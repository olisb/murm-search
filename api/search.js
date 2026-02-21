const fs = require("fs");
const path = require("path");

const EMBED_DIM = 384;
const TOP_K_DISPLAY = 20;
const TOP_K_GEO_BROWSE = 50;
const GEO_FILTER_MIN = 5;
const RELEVANCE_THRESHOLD = 0.35;

// Lazy-loaded data (persists across warm invocations)
let profilesMeta = null;
let embInt8 = null;
let embScales = null;
let knownLocations = null;
let penalties = {};
let embedder = null;

function loadData() {
  if (profilesMeta) return;
  const dataDir = path.join(__dirname, "..", "public", "data");
  profilesMeta = JSON.parse(fs.readFileSync(path.join(dataDir, "profiles-meta.json"), "utf8"));
  embInt8 = new Int8Array(fs.readFileSync(path.join(dataDir, "embeddings-int8.bin")).buffer);
  embScales = new Float32Array(fs.readFileSync(path.join(dataDir, "embeddings-scales.bin")).buffer);
  buildLocationIndex();
}

async function getEmbedder() {
  if (embedder) return embedder;
  const { pipeline } = await import("@xenova/transformers");
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  return embedder;
}

// --- Geo utilities ---

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
  france: ["france", "fr", "frankreich"], germany: ["germany", "de", "deutschland"],
  spain: ["spain", "es", "españa", "espana"], italy: ["italy", "it"],
  brazil: ["brazil", "br"], canada: ["canada", "ca"], australia: ["australia", "au"],
  india: ["india", "in"], japan: ["japan", "jp"], netherlands: ["netherlands", "nl"],
  belgium: ["belgium", "be"], austria: ["austria", "at", "österreich"],
  switzerland: ["switzerland", "ch", "schweiz", "suisse"], sweden: ["sweden", "se"],
  portugal: ["portugal", "pt"], kenya: ["kenya", "ke"], ecuador: ["ecuador", "ec"],
  ireland: ["ireland", "ie"], "new zealand": ["new zealand", "nz"],
};

function splitLocationSegments(value) {
  return value.replace(/&amp;/g, "&").split(/[:|&|]/).map(s => s.trim().toLowerCase()).filter(s => s.length >= 2);
}

function buildLocationIndex() {
  knownLocations = new Set();
  for (const p of profilesMeta) {
    if (p.locality) splitLocationSegments(p.locality).forEach(s => knownLocations.add(s));
    if (p.region) splitLocationSegments(p.region).forEach(s => knownLocations.add(s));
    if (p.country) splitLocationSegments(p.country).forEach(s => knownLocations.add(s));
  }
}

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
  "the","and","for","are","but","not","you","all","can","has","her","was","one","our","out",
  "his","how","its","may","who","did","get","let","say","she","too","use","with","that","this",
  "from","they","been","have","many","some","them","than","each","make","like","into","over",
  "such","here","what","about","which","when","there","their","will","would","could","should",
  "any","does","please","help","want","need","looking","much","got","your","every","most",
  "show","find","search","list","give","tell","see","orgs","org","know","where",
  "everything","anything","things","places","stuff",
  "projects","organisations","organizations","groups","initiatives","based","near","nearby","around","related",
]);

function extractTopicWords(query, geoTerms) {
  const geoWords = new Set();
  for (const [key, vals] of Object.entries(GEO_ALIASES)) {
    key.split(/\s+/).forEach(w => geoWords.add(w));
    vals.forEach(v => v.split(/\s+/).forEach(w => geoWords.add(w)));
  }
  if (geoTerms) geoTerms.forEach(t => t.split(/\s+/).forEach(w => geoWords.add(w)));
  return query.toLowerCase().replace(/['']/g, "").split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w) && !geoWords.has(w));
}

function topicKeywordBoost(profile, topicWords) {
  if (topicWords.length === 0) return 0;
  const text = [profile.name, profile.description, ...(profile.tags || [])].filter(Boolean).join(" ").toLowerCase();
  let matches = 0;
  for (const word of topicWords) if (text.includes(word)) matches++;
  return matches / topicWords.length;
}

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
    return { idx, profile: profilesMeta[idx], score: combined, rawSemantic: Math.min(1, semantic * (1 + kwBoost * 1.0)), kwBoost };
  }

  if (geoTerms.length > 0) {
    const geoMatchIndices = [];
    for (let i = 0; i < profilesMeta.length; i++) {
      if (profileMatchesGeo(profilesMeta[i], geoTerms)) geoMatchIndices.push(i);
    }

    if (geoMatchIndices.length >= GEO_FILTER_MIN) {
      if (!hasTopicWords) {
        const results = geoMatchIndices.map(idx => ({ idx, profile: profilesMeta[idx], score: (profilesMeta[idx].description || "").length, rawSemantic: 0, kwBoost: 0 }));
        results.sort((a, b) => b.score - a.score);
        return { results: results.slice(0, TOP_K_GEO_BROWSE), geoNote, geoTerms, topicWords, queryType, totalGeoMatches: results.length };
      }

      const scored = geoMatchIndices.map(idx => scoreProfile(idx, 1));
      scored.sort((a, b) => b.score - a.score);
      const filtered = scored.slice(0, topK).filter(r => r.rawSemantic >= RELEVANCE_THRESHOLD && r.kwBoost > 0);

      if (filtered.length === 0) {
        const fallback = geoMatchIndices.map(idx => ({ idx, profile: profilesMeta[idx], score: (profilesMeta[idx].description || "").length, rawSemantic: 0, kwBoost: 0 }));
        fallback.sort((a, b) => b.score - a.score);
        return { results: fallback.slice(0, TOP_K_GEO_BROWSE), geoNote, geoTerms, topicWords, queryType: "geo+topic-fallback", totalGeoMatches: fallback.length };
      }
      return { results: filtered, geoNote, geoTerms, topicWords, queryType };
    }

    const triedLocations = [...new Set(geoTerms)].map(t => t.charAt(0).toUpperCase() + t.slice(1));
    geoNote = `No results found matching that location. Searched: ${triedLocations.join(", ")}.`;
    return { results: [], geoNote, geoTerms, topicWords, queryType };
  }

  const allScored = [];
  for (let i = 0; i < profilesMeta.length; i++) allScored.push(scoreProfile(i, 1));
  allScored.sort((a, b) => b.score - a.score);

  const filtered = allScored.slice(0, topK).filter(r =>
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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    loadData();

    const { query, geo, topic, queryType, showAll } = req.body;
    if (!query && !topic && (!geo || geo.length === 0)) {
      return res.status(400).json({ error: "Missing query" });
    }

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
};
