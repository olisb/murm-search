/* ============================================================
   Murm Search — Client-side app (Search + Chat modes)
   ============================================================ */

const EMBED_DIM = 384;
const TOP_K_DISPLAY = 20;
const TOP_K_GEO_BROWSE = 50;
const TOP_K_LLM = 8;
const DEBOUNCE_MS = 500;
const GEO_FILTER_MIN = 5;
const RELEVANCE_THRESHOLD = 0.35;

let profiles = [];
let embeddings = null;
let map = null;
let activeCardIdx = null;
let resultMarkers = [];
let popup = null;
let currentMode = "chat";
let chatAvailable = false;
let chatBusy = false;
let chatHistory = [];     // conversation history for LLM context
let penalties = {};       // profile_url -> multiplier
let reportedThisSession = new Set(); // profile_urls reported in this session
let lastQuery = "";       // track current query for report context
let geoSample = "";       // sample of known locations for LLM

// -------------------------------------------------------------------
// Geographic aliases — maps query terms to profile field matchers
// -------------------------------------------------------------------

const GEO_ALIASES = {
  // UK nations
  uk: ["england", "scotland", "wales", "northern ireland", "united kingdom", "gb"],
  britain: ["england", "scotland", "wales", "united kingdom", "gb"],
  "united kingdom": ["england", "scotland", "wales", "northern ireland", "united kingdom", "gb"],
  england: ["england"],
  scotland: ["scotland"],
  wales: ["wales"],
  "northern ireland": ["northern ireland"],
  // UK regions
  "east anglia": ["norfolk", "suffolk", "cambridgeshire", "east anglia"],
  "west country": ["devon", "cornwall", "somerset", "dorset"],
  "home counties": ["surrey", "kent", "essex", "hertfordshire", "buckinghamshire", "berkshire"],
  midlands: ["west midlands", "east midlands", "warwickshire", "staffordshire", "derbyshire", "nottinghamshire", "leicestershire"],
  "south east": ["surrey", "kent", "sussex", "hampshire"],
  "north west": ["lancashire", "cumbria", "merseyside", "greater manchester", "cheshire"],
  "north east": ["northumberland", "tyne and wear", "county durham"],
  "greater london": ["london"],
  // US
  us: ["united states", "us", "usa"],
  usa: ["united states", "us", "usa"],
  "united states": ["united states", "us", "usa"],
  america: ["united states", "us", "usa"],
  // France
  france: ["france", "fr", "frankreich"],
  frankreich: ["france", "fr", "frankreich"],
  // Germany
  germany: ["germany", "de", "deutschland"],
  deutschland: ["germany", "de", "deutschland"],
  // Spain
  spain: ["spain", "es", "españa", "espana"],
  españa: ["spain", "es", "españa", "espana"],
  espana: ["spain", "es", "españa", "espana"],
  // Italy
  italy: ["italy", "it"],
  // Brazil
  brazil: ["brazil", "br"],
  // Canada
  canada: ["canada", "ca"],
  // Australia
  australia: ["australia", "au"],
  // India
  india: ["india", "in"],
  // Japan
  japan: ["japan", "jp"],
  // Netherlands
  netherlands: ["netherlands", "nl"],
  // Belgium
  belgium: ["belgium", "be"],
  // Austria
  austria: ["austria", "at", "österreich", "oesterreich"],
  österreich: ["austria", "at", "österreich", "oesterreich"],
  oesterreich: ["austria", "at", "österreich", "oesterreich"],
  // Switzerland
  switzerland: ["switzerland", "ch", "schweiz", "suisse", "svizzera"],
  schweiz: ["switzerland", "ch", "schweiz", "suisse", "svizzera"],
  // Sweden
  sweden: ["sweden", "se"],
  // Portugal
  portugal: ["portugal", "pt"],
  // Kenya
  kenya: ["kenya", "ke"],
  // Ecuador
  ecuador: ["ecuador", "ec"],
  // Ireland
  ireland: ["ireland", "ie"],
  // New Zealand
  "new zealand": ["new zealand", "nz"],
};

function profileMatchesGeo(profile, geoTerms) {
  const fields = [profile.country, profile.region, profile.locality]
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  for (const term of geoTerms) {
    // Build regex: term must appear at a word boundary (start/end of string
    // or preceded/followed by space, /, comma, semicolon, or hyphen).
    // This handles: "Berlin" = exact, "Berlin-Mitte" = district, "Berlin/Köln" = compound,
    // but NOT "Überlingen" (term embedded in a longer word).
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(?:^|[\\s/,;-])" + escaped + "(?:$|[\\s/,;-])");
    for (const field of fields) {
      if (re.test(field)) return true;
    }
  }
  return false;
}

// Built once after profiles load — all unique location values from the dataset
let knownLocations = null;

function buildLocationIndex() {
  knownLocations = new Set();
  for (const p of profiles) {
    if (p.locality) knownLocations.add(p.locality.toLowerCase().trim());
    if (p.region) knownLocations.add(p.region.toLowerCase().trim());
    if (p.country) knownLocations.add(p.country.toLowerCase().trim());
  }

}

function extractGeoTerms(query) {
  // Normalise: strip apostrophes, lowercase
  const q = query.toLowerCase().replace(/['']/g, "");
  const terms = [];

  // Check aliases (longest first so "east anglia" matches before "east")
  const aliasKeys = Object.keys(GEO_ALIASES).sort((a, b) => b.length - a.length);
  const matched = new Set();
  for (const key of aliasKeys) {
    if (q.includes(key) && !matched.has(key)) {
      terms.push(...GEO_ALIASES[key]);
      key.split(/\s+/).forEach((w) => matched.add(w));
      matched.add(key);
    }
  }

  if (!knownLocations) buildLocationIndex();

  // Check single words against known locations
  const words = q.split(/\s+/).filter((w) => w.length >= 3);
  for (const word of words) {
    if (terms.includes(word) || matched.has(word)) continue;
    if (knownLocations.has(word)) {
      terms.push(word);
    }
  }

  // Check consecutive word pairs (e.g. "tower hamlets", "new york")
  for (let i = 0; i < words.length - 1; i++) {
    const pair = words[i] + " " + words[i + 1];
    if (terms.includes(pair)) continue;
    if (knownLocations.has(pair)) {
      terms.push(pair);
    }
  }

  // Check consecutive triples (e.g. "city of bristol", "tyne and wear")
  for (let i = 0; i < words.length - 2; i++) {
    const triple = words[i] + " " + words[i + 1] + " " + words[i + 2];
    if (terms.includes(triple)) continue;
    if (knownLocations.has(triple)) {
      terms.push(triple);
    }
  }

  return terms;
}

// -------------------------------------------------------------------
// Data loading
// -------------------------------------------------------------------

async function loadData() {
  const countEl = document.getElementById("profile-count");
  countEl.textContent = "Loading...";

  const [metaRes, binRes] = await Promise.all([
    fetch("/data/profiles-meta.json"),
    fetch("/data/embeddings.bin"),
  ]);

  profiles = await metaRes.json();
  const buf = await binRes.arrayBuffer();
  embeddings = new Float32Array(buf);

  countEl.textContent = `${profiles.length.toLocaleString()} orgs`;
  buildLocationIndex();
  buildGeoSample();
}

function buildGeoSample() {
  const countries = new Set();
  const regionCounts = {};
  const cityCounts = {};

  for (const p of profiles) {
    if (p.country) countries.add(p.country);
    if (p.region) regionCounts[p.region] = (regionCounts[p.region] || 0) + 1;
    if (p.locality) cityCounts[p.locality] = (cityCounts[p.locality] || 0) + 1;
  }

  const topRegions = Object.entries(regionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100)
    .map(([name]) => name);
  const topCities = Object.entries(cityCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100)
    .map(([name]) => name);

  geoSample = `Countries: ${[...countries].sort().join(", ")}. Regions: ${topRegions.join(", ")}. Cities: ${topCities.join(", ")}`;
}

async function loadPenalties() {
  try {
    const res = await fetch("/api/penalties");
    penalties = await res.json();
  } catch {
    penalties = {};
  }
}

async function checkChatAvailable() {
  try {
    const res = await fetch("/api/chat-available");
    const data = await res.json();
    chatAvailable = data.available;
  } catch {
    chatAvailable = false;
  }
}

// -------------------------------------------------------------------
// Map
// -------------------------------------------------------------------

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        "carto-dark": {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
            "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
          ],
          tileSize: 256,
          attribution: '&copy; <a href="https://carto.com">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        },
      },
      layers: [
        { id: "carto-dark", type: "raster", source: "carto-dark", minzoom: 0, maxzoom: 19 },
      ],
    },
    center: [0, 30],
    zoom: 2,
  });

  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("load", () => {
    addBackgroundLayer();
    setupBackgroundClicks();
  });
}

function addBackgroundLayer() {
  const features = [];
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    if (p.latitude == null || p.longitude == null) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
      properties: { idx: i },
    });
  }

  map.addSource("all-profiles", {
    type: "geojson",
    data: { type: "FeatureCollection", features },
  });

  map.addLayer({
    id: "all-profiles-layer",
    type: "circle",
    source: "all-profiles",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 1.5, 8, 3, 14, 5],
      "circle-color": "#3a5040",
      "circle-opacity": 0.4,
    },
  });
}

function showProfilePopup(p, lngLat) {
  const loc = [p.locality, p.region, p.country].filter(Boolean).join(", ");
  const urlHtml = p.primary_url
    ? `<a href="${escHtml(fullUrl(p.primary_url))}" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px;text-decoration:none;">${escHtml(p.primary_url)}</a>`
    : "";

  if (popup) popup.remove();
  popup = new maplibregl.Popup({ offset: 8, closeButton: true, closeOnClick: false })
    .setLngLat(lngLat)
    .setHTML(`
      <div class="popup-name">${escHtml(p.name)}</div>
      ${loc ? `<div class="popup-loc">${escHtml(loc)}</div>` : ""}
      ${urlHtml ? `<div style="margin-top:4px">${urlHtml}</div>` : ""}
    `)
    .addTo(map);
}

function setupBackgroundClicks() {
  map.on("click", "all-profiles-layer", (e) => {
    e.preventDefault();
    if (!e.features || e.features.length === 0) return;
    const idx = e.features[0].properties.idx;
    const p = profiles[idx];
    if (!p) return;
    showProfilePopup(p, e.lngLat);
  });

  map.on("mouseenter", "all-profiles-layer", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "all-profiles-layer", () => {
    map.getCanvas().style.cursor = "";
  });
}

// -------------------------------------------------------------------
// Embedding + search
// -------------------------------------------------------------------

// Query expansion: add context prefix and expand related terms
function expandQuery(query) {
  let expanded = "Organisation or project related to: " + query;
  return expanded;
}

async function embedQuery(query) {
  const expanded = expandQuery(query);
  const res = await fetch("/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: expanded }),
  });
  const data = await res.json();
  return new Float32Array(data.embedding);
}

function cosineSimilarity(a, bOffset) {
  let dot = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    dot += a[i] * embeddings[bOffset + i];
  }
  return dot;
}

function extractTopicWords(query, geoTerms) {
  // Extract non-geo, non-stopword terms for keyword boosting
  const geoAliasWords = new Set();
  for (const [key, vals] of Object.entries(GEO_ALIASES)) {
    key.split(/\s+/).forEach((w) => geoAliasWords.add(w));
    vals.forEach((v) => v.split(/\s+/).forEach((w) => geoAliasWords.add(w)));
  }
  // Also strip detected geo terms (city/region names from profile data)
  if (geoTerms) {
    for (const t of geoTerms) {
      t.split(/\s+/).forEach((w) => geoAliasWords.add(w));
    }
  }
  const stopwords = new Set([
    // articles, pronouns, prepositions, conjunctions, determiners
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "has",
    "her", "was", "one", "our", "out", "his", "how", "its", "may", "who",
    "did", "get", "let", "say", "she", "too", "use", "with", "that", "this",
    "from", "they", "been", "have", "many", "some", "them", "than", "each",
    "make", "like", "into", "over", "such", "here", "what", "about",
    "which", "when", "there", "their", "will", "would", "could", "should",
    "any", "does", "please", "help", "want", "need", "looking",
    "much", "got", "your", "every", "most", "these", "those",
    "shall", "might", "just", "also", "very", "really", "quite",
    "what's", "whats",
    // query filler words
    "show", "find", "search", "list", "give", "tell", "see",
    "orgs", "org", "know", "where",
    "everything", "anything", "things", "places", "stuff",
    // domain terms treated as filler
    "projects", "organisations", "organizations", "groups", "initiatives",
    "based", "near", "nearby", "around", "related",
  ]);
  return query
    .toLowerCase()
    .replace(/['']/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopwords.has(w) && !geoAliasWords.has(w));
}

function topicKeywordBoost(profile, topicWords) {
  if (topicWords.length === 0) return 0;
  const text = [
    profile.name,
    profile.description,
    ...(profile.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let matches = 0;
  for (const word of topicWords) {
    if (text.includes(word)) matches++;
  }
  // Return a boost proportional to how many topic words matched
  return matches / topicWords.length;
}

function searchProfiles(queryEmbedding, query, topK, llmParams) {
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
    const semantic = cosineSimilarity(queryEmbedding, idx * EMBED_DIM);
    const kwBoost = topicKeywordBoost(profiles[idx], topicWords);
    const penalty = penalties[profiles[idx].profile_url] ?? 1;
    return {
      idx,
      profile: profiles[idx],
      score: semantic * geoMultiplier * (1 + kwBoost * 0.5) * penalty,
      rawSemantic: semantic,
      kwBoost,
    };
  }

  // If we have geo terms, filter to matching profiles
  if (geoTerms.length > 0) {
    const geoMatchIndices = [];
    for (let i = 0; i < profiles.length; i++) {
      if (profileMatchesGeo(profiles[i], geoTerms)) {
        geoMatchIndices.push(i);
      }
    }

    if (geoMatchIndices.length >= GEO_FILTER_MIN) {
      if (!hasTopicWords) {
        // Geo-only: return ALL matching profiles, ranked by description length
        const results = geoMatchIndices.map((idx) => {
          const p = profiles[idx];
          const descLen = (p.description || "").length;
          return { idx, profile: p, score: descLen, rawSemantic: 0, kwBoost: 0 };
        });
        results.sort((a, b) => b.score - a.score);
        const totalGeoMatches = results.length;
        return { results: results.slice(0, TOP_K_GEO_BROWSE), geoNote, geoTerms, topicWords, queryType, totalGeoMatches };
      }

      // Geo+topic: semantic rank within geo set, require keyword overlap
      const scored = geoMatchIndices.map((idx) => scoreProfile(idx, 1));
      scored.sort((a, b) => b.score - a.score);
      const topResults = scored.slice(0, topK);
      const filtered = topResults.filter((r) =>
        r.rawSemantic >= RELEVANCE_THRESHOLD && r.kwBoost > 0
      );

      // If topic filtering removed everything, fall back to geo-only browse
      // so the user still sees results for that location
      if (filtered.length === 0) {
        const fallbackResults = geoMatchIndices.map((idx) => {
          const p = profiles[idx];
          const descLen = (p.description || "").length;
          return { idx, profile: p, score: descLen, rawSemantic: 0, kwBoost: 0 };
        });
        fallbackResults.sort((a, b) => b.score - a.score);
        const totalGeoMatches = fallbackResults.length;
        return {
          results: fallbackResults.slice(0, TOP_K_GEO_BROWSE),
          geoNote, geoTerms, topicWords,
          queryType: "geo+topic-fallback",
          totalGeoMatches,
          originalTopicWords: topicWords,
        };
      }

      return { results: filtered, geoNote, geoTerms, topicWords, queryType };
    }

    // Geo terms present but no/few results — don't fall back to global.
    const triedLocations = [...new Set(geoTerms)].map((t) => t.charAt(0).toUpperCase() + t.slice(1));
    geoNote = `No results found matching that location. Searched: ${triedLocations.join(", ")}.`;
    return { results: [], geoNote, geoTerms, topicWords, queryType };
  }

  // No geo terms — pure topic search, score all profiles
  const allScored = [];
  for (let i = 0; i < profiles.length; i++) {
    allScored.push(scoreProfile(i, 1));
  }
  allScored.sort((a, b) => b.score - a.score);

  const topResults = allScored.slice(0, topK);
  // Drop off-topic results: no keyword overlap AND weak embedding match
  const filtered = topResults.filter((r) =>
    r.rawSemantic >= RELEVANCE_THRESHOLD &&
    (!hasTopicWords || r.kwBoost > 0 || r.rawSemantic >= 0.5)
  );

  return { results: filtered, geoNote, geoTerms, topicWords, queryType };
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fullUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return "https://" + url;
}

function relevanceBarHtml(score) {
  const pct = Math.round(score * 100);
  const color = score >= 0.5 ? "var(--accent)" : score >= RELEVANCE_THRESHOLD ? "#d4a940" : "#e87070";
  return `<div class="relevance-bar"><div class="relevance-fill" style="width:${pct}%;background:${color}"></div><span class="relevance-pct">${pct}%</span></div>`;
}

// -------------------------------------------------------------------
// Report system
// -------------------------------------------------------------------

const FLAG_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`;

function reportBtnHtml(profileUrl, profileName, primaryUrl) {
  const data = escHtml(JSON.stringify({ profileUrl, profileName, primaryUrl })).replace(/'/g, "&#39;");
  return `<button class="report-btn" data-report='${data}' title="Report">${FLAG_ICON}</button>`;
}

function showReportModal(profileUrl, profileName, primaryUrl) {
  // Remove existing modal
  const existing = document.getElementById("report-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "report-modal";
  modal.className = "report-modal-overlay";
  modal.innerHTML = `
    <div class="report-modal">
      <div class="report-modal-title">Report: ${escHtml(profileName || "Unknown")}</div>
      <button class="report-option" data-type="dead_link">Website not working</button>
      <button class="report-option" data-type="irrelevant">Irrelevant result</button>
      <button class="report-option" data-type="feedback_expand">Other feedback</button>
      <div class="report-feedback-wrap hidden">
        <input type="text" class="report-feedback-input" placeholder="Your feedback..." />
        <button class="report-feedback-send">Send</button>
      </div>
      <button class="report-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(modal);

  // Close on overlay click
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector(".report-cancel").addEventListener("click", () => modal.remove());

  // Quick report options
  modal.querySelectorAll(".report-option").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const type = btn.dataset.type;

      if (type === "feedback_expand") {
        modal.querySelector(".report-feedback-wrap").classList.remove("hidden");
        modal.querySelector(".report-feedback-input").focus();
        return;
      }

      await submitReport(profileUrl, profileName, primaryUrl, type, null);
      markReported(profileUrl);
      modal.remove();
    });
  });

  // Feedback send
  modal.querySelector(".report-feedback-send").addEventListener("click", async () => {
    const input = modal.querySelector(".report-feedback-input");
    const message = input.value.trim();
    if (!message) return;
    await submitReport(profileUrl, profileName, primaryUrl, "feedback", message);
    markReported(profileUrl);
    modal.remove();
  });

  modal.querySelector(".report-feedback-input").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      modal.querySelector(".report-feedback-send").click();
    }
  });
}

async function submitReport(profileUrl, profileName, primaryUrl, reportType, message) {
  try {
    await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile_url: profileUrl,
        profile_name: profileName,
        primary_url: primaryUrl,
        report_type: reportType,
        query: lastQuery,
        message,
      }),
    });
    // Reload penalties
    await loadPenalties();
  } catch (err) {
    console.error("Report failed:", err);
  }
}

function markReported(profileUrl) {
  reportedThisSession.add(profileUrl);
  // Dim all cards for this profile
  document.querySelectorAll(`[data-profile-url="${CSS.escape(profileUrl)}"]`).forEach((card) => {
    card.classList.add("reported");
  });
}

function attachReportButtons(container) {
  container.querySelectorAll(".report-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const data = JSON.parse(btn.dataset.report);
      showReportModal(data.profileUrl, data.profileName, data.primaryUrl);
    });
  });
}

// -------------------------------------------------------------------
// Map markers
// -------------------------------------------------------------------

function clearMarkers() {
  resultMarkers.forEach((m) => m.remove());
  resultMarkers = [];
  if (popup) { popup.remove(); popup = null; }
}

function plotResults(results) {
  clearMarkers();
  const coords = []; // collect coords for outlier-aware bounds

  results.forEach((r, i) => {
    const p = r.profile;
    if (p.latitude == null || p.longitude == null) return;

    const el = document.createElement("div");
    el.className = "result-marker";
    el.style.cssText = `
      width: 24px; height: 24px;
      background: #4ecb71;
      border: 2px solid #0f1210;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; color: #0f1210;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      transition: transform 0.15s;
    `;
    el.textContent = i + 1;
    el.dataset.idx = r.idx;

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([p.longitude, p.latitude])
      .addTo(map);

    el.addEventListener("click", () => highlightMarker(r.idx));

    resultMarkers.push(marker);
    coords.push([p.longitude, p.latitude]);
  });

  if (coords.length === 0) return;

  // Compute bounds excluding geographic outliers (using IQR method)
  // This prevents a single distant marker from zooming the map out
  const boundsCoords = excludeGeoOutliers(coords);
  const bounds = new maplibregl.LngLatBounds();
  for (const [lng, lat] of boundsCoords) {
    bounds.extend([lng, lat]);
  }
  map.fitBounds(bounds, { padding: 60, maxZoom: 10, duration: 800 });
}

function excludeGeoOutliers(coords) {
  if (coords.length <= 3) return coords;

  const lats = coords.map((c) => c[1]).sort((a, b) => a - b);
  const lngs = coords.map((c) => c[0]).sort((a, b) => a - b);

  const q1Lat = lats[Math.floor(lats.length * 0.25)];
  const q3Lat = lats[Math.floor(lats.length * 0.75)];
  const iqrLat = q3Lat - q1Lat;
  const q1Lng = lngs[Math.floor(lngs.length * 0.25)];
  const q3Lng = lngs[Math.floor(lngs.length * 0.75)];
  const iqrLng = q3Lng - q1Lng;

  // Use generous bounds (3x IQR) to only exclude clear outliers
  const margin = 3;
  const latMin = q1Lat - margin * Math.max(iqrLat, 0.5);
  const latMax = q3Lat + margin * Math.max(iqrLat, 0.5);
  const lngMin = q1Lng - margin * Math.max(iqrLng, 0.5);
  const lngMax = q3Lng + margin * Math.max(iqrLng, 0.5);

  const filtered = coords.filter(
    ([lng, lat]) => lat >= latMin && lat <= latMax && lng >= lngMin && lng <= lngMax
  );

  // If everything got filtered (shouldn't happen), fall back to all coords
  return filtered.length > 0 ? filtered : coords;
}

function highlightMarker(idx) {
  // Highlight the corresponding card/mini-card
  document.querySelectorAll(".card, .mini-card").forEach((c) => c.classList.remove("active"));
  const card = document.querySelector(`[data-idx="${idx}"]`);
  if (card) {
    card.classList.add("active");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Show popup for the clicked profile
  const p = profiles[idx];
  if (p) {
    showProfilePopup(p, [p.longitude, p.latitude]);
  }

  activeCardIdx = idx;
}

// -------------------------------------------------------------------
// Search mode
// -------------------------------------------------------------------

function renderSearchResults(results, geoNote) {
  const container = document.getElementById("results");
  const empty = document.getElementById("empty-state");

  if (results.length === 0) {
    const msg = geoNote || "No strong matches found. Try broader or different search terms.";
    container.innerHTML = `<div class="no-results">${escHtml(msg)} Try different location terms or a broader search.</div>`;
    empty.style.display = "none";
    return;
  }

  empty.style.display = "none";
  container.innerHTML = results
    .map((r, i) => {
      const p = r.profile;
      const locParts = [p.locality, p.region, p.country].filter(Boolean);
      const location = locParts.join(", ");
      const nameHtml = p.primary_url
        ? `<a href="${escHtml(fullUrl(p.primary_url))}" target="_blank" rel="noopener">${escHtml(p.name)}</a>`
        : escHtml(p.name);
      const tags = (p.tags || [])
        .slice(0, 5)
        .map((t) => `<span class="tag">${escHtml(t)}</span>`)
        .join("");

      const hiddenClass = i >= CARDS_COLLAPSED ? " card-overflow" : "";
      const reportedClass = reportedThisSession.has(p.profile_url) ? " reported" : "";
      return `
        <div class="card${hiddenClass}${reportedClass}" data-idx="${r.idx}" data-rank="${i}" data-profile-url="${escHtml(p.profile_url || "")}">
          ${reportBtnHtml(p.profile_url, p.name, p.primary_url)}
          <div class="card-rank">#${i + 1}</div>
          <div class="card-name">${nameHtml}</div>
          ${p.primary_url ? `<div class="card-url"><a href="${escHtml(fullUrl(p.primary_url))}" target="_blank" rel="noopener">${escHtml(p.primary_url)}</a></div>` : ""}
          ${location ? `<div class="card-location">${escHtml(location)}</div>` : ""}
          ${p.description ? `<div class="card-desc">${escHtml(p.description)}</div>` : ""}
          ${tags ? `<div class="card-tags">${tags}</div>` : ""}
          ${r.rawSemantic > 0 ? relevanceBarHtml(r.rawSemantic) : ""}
        </div>`;
    })
    .join("");

  if (results.length > CARDS_COLLAPSED) {
    const extra = results.length - CARDS_COLLAPSED;
    container.insertAdjacentHTML("beforeend",
      `<button class="show-more-btn" onclick="this.parentElement.classList.add('expanded'); this.remove();">Show ${extra} more</button>`
    );
  }

  attachReportButtons(container);
  container.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.tagName === "A" || e.target.closest(".report-btn")) return;
      highlightMarker(parseInt(card.dataset.idx));
    });
  });
}

let searchTimeout = null;

async function handleSearch(query) {
  if (!query.trim()) {
    document.getElementById("results").innerHTML = "";
    document.getElementById("empty-state").style.display = "";
    clearMarkers();
    return;
  }

  lastQuery = query.trim();
  document.body.classList.add("loading");
  try {
    const queryEmb = await embedQuery(query);
    const { results, geoNote, queryType, topicWords } = searchProfiles(queryEmb, query, TOP_K_DISPLAY);
    console.log('[search]', { query, queryType, topicWords, totalResults: results.length });
    results.slice(0, 5).forEach((r, i) => {
      console.log(`  #${i+1} "${r.profile.name}" semantic=${r.rawSemantic.toFixed(3)} kwBoost=${r.kwBoost.toFixed(3)} score=${r.score.toFixed(3)}`);
    });
    renderSearchResults(results, geoNote);
    plotResults(results);
  } catch (err) {
    console.error("Search error:", err);
  } finally {
    document.body.classList.remove("loading");
  }
}

// -------------------------------------------------------------------
// Chat mode
// -------------------------------------------------------------------

const CARDS_COLLAPSED = 5;

function buildMiniCardHtml(r, i) {
  const p = r.profile;
  const loc = [p.locality, p.region, p.country].filter(Boolean).join(", ");
  const nameHtml = p.primary_url
    ? `<a href="${escHtml(fullUrl(p.primary_url))}" target="_blank" rel="noopener">${escHtml(p.name)}</a>`
    : escHtml(p.name);
  const tags = (p.tags || [])
    .slice(0, 4)
    .map((t) => `<span class="tag">${escHtml(t)}</span>`)
    .join("");

  const hiddenClass = i >= CARDS_COLLAPSED ? " mini-card-overflow" : "";
  const reportedClass = reportedThisSession.has(p.profile_url) ? " reported" : "";
  return `
    <div class="mini-card${hiddenClass}${reportedClass}" data-idx="${r.idx}" data-profile-url="${escHtml(p.profile_url || "")}">
      <span class="mini-card-num">${i + 1}</span>
      <div class="mini-card-body">
        <div class="mini-card-name">${nameHtml}</div>
        ${p.primary_url ? `<div class="mini-card-url"><a href="${escHtml(fullUrl(p.primary_url))}" target="_blank" rel="noopener">${escHtml(p.primary_url)}</a></div>` : ""}
        ${loc ? `<div class="mini-card-loc">${escHtml(loc)}</div>` : ""}
        ${p.description ? `<div class="mini-card-desc">${escHtml(p.description)}</div>` : ""}
        ${tags ? `<div class="mini-card-tags">${tags}</div>` : ""}
        ${r.rawSemantic > 0 ? relevanceBarHtml(r.rawSemantic) : ""}
      </div>
      ${reportBtnHtml(p.profile_url, p.name, p.primary_url)}
    </div>`;
}

function buildMiniCardsHtml(results) {
  let html = results.map((r, i) => buildMiniCardHtml(r, i)).join("");
  if (results.length > CARDS_COLLAPSED) {
    const extra = results.length - CARDS_COLLAPSED;
    html += `<button class="show-more-btn" onclick="this.parentElement.classList.add('expanded'); this.remove();">Show ${extra} more</button>`;
  }
  return html;
}

function addChatMessage(role, html) {
  const container = document.getElementById("chat-messages");

  const welcome = container.querySelector(".chat-welcome");
  if (welcome) welcome.remove();

  const msg = document.createElement("div");
  msg.className = `chat-msg ${role}`;
  msg.innerHTML = html;
  container.appendChild(msg);
  msg.scrollIntoView({ behavior: "smooth", block: "start" });
  return msg;
}

function addUserBubble(text) {
  addChatMessage("user", `<div class="chat-bubble">${escHtml(text)}</div>`);
}

function addThinkingBubble() {
  const msg = addChatMessage(
    "assistant",
    `<div class="chat-bubble thinking"><span class="typing-dots"><span></span><span></span><span></span></span></div>`
  );
  msg.id = "thinking-bubble";
  return msg;
}

function removeThinkingBubble() {
  const el = document.getElementById("thinking-bubble");
  if (el) el.remove();
}

function attachMiniCardClicks(container) {
  attachReportButtons(container);
  container.querySelectorAll(".mini-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.tagName === "A" || e.target.closest(".report-btn")) return;
      highlightMarker(parseInt(card.dataset.idx));
    });
  });
}

function addAssistantResponse(text, results) {
  const cardsHtml = buildMiniCardsHtml(results);
  const msg = addChatMessage(
    "assistant",
    `<div class="chat-bubble">${escHtml(text)}</div>
     <div class="chat-profiles">${cardsHtml}</div>`
  );
  attachMiniCardClicks(msg);
}

function addAssistantError(text) {
  addChatMessage(
    "assistant",
    `<div class="chat-bubble error">${escHtml(text)}</div>`
  );
}

function addSearchOnlyResponse(results, geoNote) {
  if (results.length === 0) {
    addChatMessage("assistant",
      `<div class="chat-bubble">I couldn't find a good match for that in the network. Try broadening your search — for example, use more general terms or a wider location.</div>`);
    return;
  }
  const noteHtml = geoNote
    ? `<div class="chat-bubble">${escHtml(geoNote)}</div>`
    : results.length < 3
      ? `<div class="chat-bubble">I only found ${results.length} close match${results.length === 1 ? "" : "es"} for that query:</div>`
      : `<div class="chat-bubble">Here are the most relevant organisations I found:</div>`;
  const cardsHtml = buildMiniCardsHtml(results);
  const msg = addChatMessage(
    "assistant",
    `${noteHtml}
     <div class="chat-profiles">${cardsHtml}</div>`
  );
  attachMiniCardClicks(msg);
}

function fireTryQuery(el) {
  const query = el.textContent;
  handleChat(query);
}

async function handleChat(query) {
  if (!query.trim() || chatBusy) return;

  chatBusy = true;
  lastQuery = query.trim();
  const sendBtn = document.getElementById("chat-send");
  const chatInput = document.getElementById("chat-input");
  sendBtn.disabled = true;
  chatInput.value = "";

  addUserBubble(query);
  addThinkingBubble();

  try {
    // Step 1: Understand the query (single LLM call for classification + rewriting + geo/topic extraction)
    let llmResult = null;

    if (chatAvailable) {
      try {
        const uRes = await fetch("/api/understand", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: query, history: chatHistory.slice(-6), sampleLocations: geoSample }),
        });
        llmResult = await uRes.json();
        console.log('[understand]', llmResult);
      } catch (err) {
        console.error("Understand error:", err);
      }
    }

    // Step 2: If chat, show response directly (no search needed)
    if (llmResult?.action === "chat") {
      chatHistory.push({ role: "user", content: query });
      removeThinkingBubble();
      const response = llmResult.chatResponse || "I can help you search for organisations. What are you looking for?";
      addChatMessage("assistant", `<div class="chat-bubble">${escHtml(response)}</div>`);
      chatHistory.push({ role: "assistant", content: response });
      chatBusy = false;
      sendBtn.disabled = false;
      chatInput.focus();
      return;
    }

    // Step 3: Run search pipeline
    const searchTopic = llmResult?.topic || query;
    let queryEmb = null;
    if (!llmResult || llmResult.queryType !== "geo-only") {
      queryEmb = await embedQuery(searchTopic);
    }

    const searchResult = llmResult
      ? searchProfiles(queryEmb, searchTopic, TOP_K_DISPLAY, llmResult)
      : searchProfiles(queryEmb, query, TOP_K_DISPLAY);
    let { results: allResults, geoNote, geoTerms, topicWords, queryType, totalGeoMatches, originalTopicWords } = searchResult;

    // Debug: log top 5 results with scores
    console.log('[search]', { query: searchTopic, queryType, geoTerms, topicWords, totalResults: allResults.length });
    allResults.slice(0, 5).forEach((r, i) => {
      console.log(`  #${i+1} "${r.profile.name}" semantic=${r.rawSemantic.toFixed(3)} kwBoost=${r.kwBoost.toFixed(3)} score=${r.score.toFixed(3)}`);
    });

    // Show results on map
    plotResults(allResults);

    // Handle zero results
    if (allResults.length === 0) {
      removeThinkingBubble();
      const msg = geoNote
        ? `<div class="chat-bubble">${escHtml(geoNote)} Try different location terms or a broader search.</div>`
        : `<div class="chat-bubble">I couldn't find a good match for that in the network. Try broadening your search — for example, use more general terms or a wider location.</div>`;
      addChatMessage("assistant", msg);
      chatBusy = false;
      sendBtn.disabled = false;
      chatInput.focus();
      return;
    }

    // Geo+topic fallback: topic search found nothing, but geo location has results.
    // Send to LLM with context about the failed topic filter.
    if (queryType === "geo+topic-fallback") {
      const topicStr = (originalTopicWords || topicWords || []).join(", ");
      const count = totalGeoMatches || allResults.length;
      // Find any loosely related profiles to mention to the LLM
      const topicRelated = allResults.filter((r) => {
        const text = [r.profile.name, r.profile.description, ...(r.profile.tags || [])].filter(Boolean).join(" ").toLowerCase();
        return (originalTopicWords || topicWords || []).some((w) => text.includes(w));
      }).slice(0, 5);
      const relatedNames = topicRelated.map((r) => r.profile.name);
      geoNote = `No results specifically matching "${topicStr}" were found. Showing all ${count} organisations in that location instead.${relatedNames.length > 0 ? ` Possibly related: ${relatedNames.join(", ")}.` : ""}`;
    }

    // Geo-only browse: skip LLM, just show count
    if (queryType === "geo-only") {
      removeThinkingBubble();
      const count = totalGeoMatches || allResults.length;
      const showing = allResults.length < count ? ` Showing top ${allResults.length}.` : "";
      addAssistantResponse(`${count} organisations found.${showing}`, allResults);
      chatHistory.push({ role: "user", content: query });
      chatHistory.push({ role: "assistant", content: `${count} organisations found.` });
      chatBusy = false;
      sendBtn.disabled = false;
      chatInput.focus();
      return;
    }

    // Send top 8 to LLM with scores for conversational response
    const llmProfiles = allResults.slice(0, TOP_K_LLM).map((r) => ({
      ...r.profile,
      _relevance: r.rawSemantic > 0 ? Math.round(r.rawSemantic * 100) : null,
    }));

    // Track user message in history
    chatHistory.push({ role: "user", content: query });

    if (chatAvailable) {
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: query,
            profiles: llmProfiles,
            totalResults: totalGeoMatches || allResults.length,
            geoNote: geoNote || null,
            queryType: queryType || "unknown",
            geoTerms: geoTerms || [],
            topicKeywords: topicWords || [],
            history: chatHistory.slice(-10),
          }),
        });

        removeThinkingBubble();

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.error("Chat API error:", data.error);
          addAssistantError(data.error || "Something went wrong.");
          addSearchOnlyResponse(allResults, geoNote);
        } else {
          // Stream the response
          const cardsHtml = buildMiniCardsHtml(allResults);
          const msg = addChatMessage("assistant",
            `<div class="chat-bubble"></div>
             <div class="chat-profiles">${cardsHtml}</div>`);
          attachMiniCardClicks(msg);
          const bubble = msg.querySelector(".chat-bubble");
          let fullText = "";

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6);
              if (payload === "[DONE]") continue;
              try {
                const chunk = JSON.parse(payload);
                if (chunk.error) {
                  console.error("Chat stream error:", chunk.error);
                  continue;
                }
                if (chunk.text) {
                  fullText += chunk.text;
                  bubble.textContent = fullText;
                  msg.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              } catch (e) {}
            }
          }

          if (fullText) {
            chatHistory.push({ role: "assistant", content: fullText });
          } else {
            addSearchOnlyResponse(allResults, geoNote);
          }
        }
      } catch (err) {
        console.error("Chat fetch error:", err);
        removeThinkingBubble();
        addSearchOnlyResponse(allResults, geoNote);
      }
    } else {
      removeThinkingBubble();
      addSearchOnlyResponse(allResults, geoNote);
    }
  } catch (err) {
    console.error("Chat error:", err);
    removeThinkingBubble();
    addAssistantError("Something went wrong. Please try again.");
  } finally {
    chatBusy = false;
    sendBtn.disabled = false;
    chatInput.focus();
  }
}

// -------------------------------------------------------------------
// Mode switching
// -------------------------------------------------------------------

function setMode(mode) {
  currentMode = mode;

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  const searchWrap = document.getElementById("search-wrap");
  const searchPanel = document.getElementById("search-panel");
  const chatPanel = document.getElementById("chat-panel");

  if (mode === "search") {
    searchWrap.classList.remove("hidden");
    searchPanel.classList.remove("hidden");
    chatPanel.classList.add("hidden");
    document.getElementById("search-input").focus();
  } else {
    searchWrap.classList.add("hidden");
    searchPanel.classList.add("hidden");
    chatPanel.classList.remove("hidden");
    document.getElementById("chat-input").focus();
  }
}

// -------------------------------------------------------------------
// Init
// -------------------------------------------------------------------

async function init() {
  initMap();
  await Promise.all([loadData(), checkChatAvailable(), loadPenalties()]);

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  if (!chatAvailable) {
    setMode("search");
  } else {
    setMode("chat");
  }

  const welcome = document.querySelector(".chat-welcome");
  if (welcome) welcome.style.visibility = "visible";

  // Search mode input
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(searchTimeout);
      handleSearch(searchInput.value);
    }
  });
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => handleSearch(searchInput.value), DEBOUNCE_MS);
  });

  // Chat mode input
  const chatInput = document.getElementById("chat-input");
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleChat(chatInput.value);
    }
  });
  document.getElementById("chat-send").addEventListener("click", () => {
    handleChat(chatInput.value);
  });
}

init();
