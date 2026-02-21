/* ============================================================
   Murm Search — Client-side app (Search + Chat modes)
   Server-side search via /api/search
   ============================================================ */

const DEBOUNCE_MS = 500;
const RELEVANCE_THRESHOLD = 0.35;

let mapPoints = [];
let map = null;
let activeCardIdx = null;
let resultMarkers = [];
let popup = null;
let currentMode = "chat";
let chatAvailable = false;
let chatBusy = false;
let chatHistory = [];
let reportedThisSession = new Set();
let lastQuery = "";

// -------------------------------------------------------------------
// Data loading — lightweight map points + stats from server
// -------------------------------------------------------------------

async function loadMapPoints() {
  const countEl = document.getElementById("profile-count");
  countEl.textContent = "Loading...";

  const [pointsRes, statsRes] = await Promise.all([
    fetch("/data/map-points.json"),
    fetch("/api/stats"),
  ]);

  mapPoints = await pointsRes.json();
  const stats = await statsRes.json();

  countEl.textContent = `${stats.totalProfiles.toLocaleString()} orgs`;
  const emptyCount = document.getElementById("empty-count");
  if (emptyCount) emptyCount.textContent = stats.totalProfiles.toLocaleString();
  const welcomeCount = document.getElementById("welcome-count");
  if (welcomeCount) welcomeCount.textContent = (Math.floor(stats.totalProfiles / 1000) * 1000).toLocaleString();
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
}

function addBackgroundLayer() {
  const features = [];
  for (let i = 0; i < mapPoints.length; i++) {
    const p = mapPoints[i];
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
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
  const loc = p.loc || "";
  const urlHtml = p.url
    ? `<a href="${escHtml(fullUrl(p.url))}" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px;text-decoration:none;">${escHtml(p.url)}</a>`
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
    const p = mapPoints[idx];
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
// Server-side search via API
// -------------------------------------------------------------------

async function apiSearch(params) {
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json();
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

function relevanceBarHtml(pct) {
  const score = pct / 100;
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

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector(".report-cancel").addEventListener("click", () => modal.remove());

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
  } catch (err) {
    console.error("Report failed:", err);
  }
}

function markReported(profileUrl) {
  reportedThisSession.add(profileUrl);
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
  const coords = [];

  results.forEach((p, i) => {
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

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([p.longitude, p.latitude])
      .addTo(map);

    el.addEventListener("click", () => highlightResult(i, p));

    resultMarkers.push(marker);
    coords.push([p.longitude, p.latitude]);
  });

  if (coords.length === 0) return;

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

  const margin = 3;
  const latMin = q1Lat - margin * Math.max(iqrLat, 0.5);
  const latMax = q3Lat + margin * Math.max(iqrLat, 0.5);
  const lngMin = q1Lng - margin * Math.max(iqrLng, 0.5);
  const lngMax = q3Lng + margin * Math.max(iqrLng, 0.5);

  const filtered = coords.filter(
    ([lng, lat]) => lat >= latMin && lat <= latMax && lng >= lngMin && lng <= lngMax
  );

  return filtered.length > 0 ? filtered : coords;
}

function highlightResult(rank, profile, clickedCard) {
  document.querySelectorAll(".card, .mini-card").forEach((c) => c.classList.remove("active"));
  // Use last matching card (most recent search) when no specific card is passed
  const card = clickedCard || [...document.querySelectorAll(`[data-rank="${rank}"]`)].pop();
  if (card) {
    card.classList.add("active");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  if (profile && profile.latitude != null && profile.longitude != null) {
    const loc = [profile.locality, profile.region, profile.country].filter(Boolean).join(", ");
    showResultPopup(profile, [profile.longitude, profile.latitude]);
  }
}

function showResultPopup(p, lngLat) {
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
    .map((p, i) => {
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
        <div class="card${hiddenClass}${reportedClass}" data-rank="${i}" data-profile-url="${escHtml(p.profile_url || "")}">
          ${reportBtnHtml(p.profile_url, p.name, p.primary_url)}
          <div class="card-rank">#${i + 1}${p.source === "openstreetmap" ? ' <span class="card-source osm">via OpenStreetMap</span>' : p.source === "kvm" ? ' <span class="card-source kvm">via KVM</span>' : ' <span class="card-source murm">via Murmurations</span>'}</div>
          <div class="card-name">${nameHtml}</div>
          ${p.primary_url ? `<div class="card-url"><a href="${escHtml(fullUrl(p.primary_url))}" target="_blank" rel="noopener">${escHtml(p.primary_url)}</a></div>` : ""}
          ${location ? `<div class="card-location">${escHtml(location)}</div>` : ""}
          ${p.description ? `<div class="card-desc">${escHtml(p.description)}</div>` : ""}
          ${tags ? `<div class="card-tags">${tags}</div>` : ""}
          ${p._relevance > 0 ? relevanceBarHtml(p._relevance) : ""}
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
      const rank = parseInt(card.dataset.rank);
      highlightResult(rank, results[rank], card);
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
    const data = await apiSearch({ query: query.trim() });
    console.log('[search]', { query, queryType: data.queryType, totalResults: data.results.length });
    renderSearchResults(data.results, data.geoNote);
    plotResults(data.results);
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

function buildMiniCardHtml(p, i) {
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
    <div class="mini-card${hiddenClass}${reportedClass}" data-rank="${i}" data-profile-url="${escHtml(p.profile_url || "")}">
      <span class="mini-card-num">${i + 1}</span>
      <div class="mini-card-body">
        <div class="mini-card-name">${nameHtml}${p.source === "openstreetmap" ? ' <span class="card-source osm">via OSM</span>' : ""}</div>
        ${p.primary_url ? `<div class="mini-card-url"><a href="${escHtml(fullUrl(p.primary_url))}" target="_blank" rel="noopener">${escHtml(p.primary_url)}</a></div>` : ""}
        ${loc ? `<div class="mini-card-loc">${escHtml(loc)}</div>` : ""}
        ${p.description ? `<div class="mini-card-desc">${escHtml(p.description)}</div>` : ""}
        ${tags ? `<div class="mini-card-tags">${tags}</div>` : ""}
        ${p._relevance > 0 ? relevanceBarHtml(p._relevance) : ""}
      </div>
      ${reportBtnHtml(p.profile_url, p.name, p.primary_url)}
    </div>`;
}

function buildMiniCardsHtml(results) {
  let html = results.map((p, i) => buildMiniCardHtml(p, i)).join("");
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

function attachMiniCardClicks(container, results) {
  attachReportButtons(container);
  container.querySelectorAll(".mini-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.tagName === "A" || e.target.closest(".report-btn")) return;
      const rank = parseInt(card.dataset.rank);
      highlightResult(rank, results[rank], card);
    });
  });
}

function addAssistantResponse(text, results) {
  const cardsHtml = buildMiniCardsHtml(results);
  const msg = addChatMessage(
    "assistant",
    `<div class="chat-bubble">${linkifySuggestions(text)}</div>
     <div class="chat-profiles">${cardsHtml}</div>`
  );
  attachMiniCardClicks(msg, results);
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
  attachMiniCardClicks(msg, results);
}

function fireTryQuery(el) {
  const query = el.textContent;
  handleChat(query);
}

function fireTrySearch(el) {
  const query = el.textContent;
  const input = document.getElementById("search-input");
  if (input) input.value = query;
  handleSearch(query);
}

// Convert "quoted suggestions" in LLM text into clickable links
function linkifySuggestions(text) {
  return text.replace(/\u201c([^\u201d]+)\u201d|"([^"]+)"/g, (match, q1, q2) => {
    const q = q1 || q2;
    return `<a href="#" class="try-link" onclick="fireTryQuery(this); return false;">${escHtml(q)}</a>`;
  });
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
    // Step 1: Understand the query
    let llmResult = null;

    if (chatAvailable) {
      try {
        const uRes = await fetch("/api/understand", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: query, history: chatHistory.slice(-6) }),
        });
        llmResult = await uRes.json();
        console.log('[understand]', llmResult);
      } catch (err) {
        console.error("Understand error:", err);
      }
    }

    // Step 2: If chat, show response directly
    if (llmResult?.action === "chat") {
      chatHistory.push({ role: "user", content: query });
      removeThinkingBubble();
      const response = llmResult.chatResponse || "I can help you search for organisations. What are you looking for?";
      addChatMessage("assistant", `<div class="chat-bubble">${linkifySuggestions(response)}</div>`);
      chatHistory.push({ role: "assistant", content: response });
      chatBusy = false;
      sendBtn.disabled = false;
      chatInput.focus();
      return;
    }

    // Step 3: Run search via API
    const searchParams = llmResult
      ? { query, geo: llmResult.geo, topic: llmResult.topic, queryType: llmResult.queryType, showAll: llmResult.showAll }
      : { query };

    const searchData = await apiSearch(searchParams);
    const allResults = searchData.results;
    const geoNote = searchData.geoNote;
    const queryType = searchData.queryType;
    const totalResults = searchData.totalResults;

    console.log('[search]', { query, queryType, totalResults: allResults.length });

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

    // Geo-only browse: skip LLM, just show count
    if (queryType === "geo-only") {
      removeThinkingBubble();
      const count = totalResults || allResults.length;
      const showing = allResults.length < count ? ` Showing top ${allResults.length}.` : "";
      addAssistantResponse(`${count} organisations found.${showing}`, allResults);
      chatHistory.push({ role: "user", content: query });
      chatHistory.push({ role: "assistant", content: `${count} organisations found.` });
      chatBusy = false;
      sendBtn.disabled = false;
      chatInput.focus();
      return;
    }

    // Track user message in history
    chatHistory.push({ role: "user", content: query });

    if (chatAvailable) {
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            geo: llmResult?.geo || [],
            topic: llmResult?.topic || "",
            queryType: queryType || "unknown",
            showAll: llmResult?.showAll || false,
            geoNote: geoNote || null,
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
          attachMiniCardClicks(msg, allResults);
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
            bubble.innerHTML = linkifySuggestions(fullText);
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
  const mapReady = new Promise(resolve => map.on("load", resolve));
  await Promise.all([loadMapPoints(), checkChatAvailable(), mapReady]);

  addBackgroundLayer();
  setupBackgroundClicks();

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
