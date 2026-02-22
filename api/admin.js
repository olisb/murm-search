const { getQueryLogs } = require("./_log");

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

module.exports = async function handler(req, res) {
  // Password check via query param or cookie
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return res.status(501).send("ADMIN_PASSWORD not configured");
  }

  const providedPw = req.query?.pw || parseCookie(req.headers.cookie, "admin_pw");
  if (providedPw !== password) {
    return res.status(200).send(loginPage());
  }

  // Set cookie so they don't need to re-enter
  res.setHeader("Set-Cookie", `admin_pw=${password}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);

  const tab = req.query?.tab || "queries";
  const logs = tab === "queries" ? await getQueryLogs(500) : [];

  res.status(200).send(adminPage(logs, tab));
};

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

function loginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CoBot Admin</title>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-LB5K7C4GGQ"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-LB5K7C4GGQ');</script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1210; color: #d4ddd6; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .login { background: #171d19; border: 1px solid #2a3630; border-radius: 12px; padding: 32px; width: 320px; }
  h1 { font-size: 18px; margin-bottom: 16px; }
  h1 span { color: #4ecb71; }
  input { width: 100%; padding: 10px 12px; background: #0f1210; border: 1px solid #2a3630; border-radius: 6px; color: #d4ddd6; font-size: 14px; margin-bottom: 12px; }
  input:focus { outline: none; border-color: #4ecb71; }
  button { width: 100%; padding: 10px; background: #4ecb71; border: none; border-radius: 6px; color: #0f1210; font-weight: 600; cursor: pointer; font-size: 14px; }
  button:hover { background: #3db85e; }
</style>
</head>
<body>
  <div class="login">
    <h1>Co<span>Bot</span> Admin</h1>
    <form method="GET">
      <input type="password" name="pw" placeholder="Password" autofocus>
      <button type="submit">Login</button>
    </form>
  </div>
</body>
</html>`;
}

function adminPage(logs, activeTab) {
  const now = new Date();
  const last24h = logs.filter(l => (now - new Date(l.ts)) < 86400000);
  const lastHour = logs.filter(l => (now - new Date(l.ts)) < 3600000);
  const chatCount = logs.filter(l => l.type === "chat").length;
  const searchCount = logs.filter(l => l.type === "search").length;

  const rows = logs.map(l => `
    <tr>
      <td>${esc(l.ts ? l.ts.slice(0, 19).replace("T", " ") : "")}</td>
      <td><span class="qtype qtype-${esc(l.type)}">${esc(l.type)}</span></td>
      <td title="${esc(l.query)}">${esc(truncate(l.query, 60))}</td>
      <td>${esc(Array.isArray(l.geo) ? l.geo.join(", ") : (l.geo || ""))}</td>
      <td>${esc(l.queryType)}</td>
      <td>${l.resultCount || 0}</td>
      <td>${esc(l.ip)}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CoBot Admin</title>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-LB5K7C4GGQ"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-LB5K7C4GGQ');</script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1210; color: #d4ddd6; padding: 24px; }
  h1 { font-size: 22px; margin-bottom: 16px; }
  h1 span { color: #4ecb71; }
  .tabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .tab { padding: 8px 16px; background: #171d19; border: 1px solid #2a3630; border-radius: 6px; color: #7a8f80; text-decoration: none; font-size: 13px; }
  .tab.active { background: #1c2e22; border-color: #4ecb71; color: #4ecb71; }
  .tab:hover { border-color: #4ecb71; color: #d4ddd6; }
  .summary { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { padding: 12px 20px; background: #171d19; border: 1px solid #2a3630; border-radius: 8px; font-size: 14px; }
  .stat strong { color: #4ecb71; font-size: 20px; display: block; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; background: #171d19; border-bottom: 2px solid #2a3630; color: #7a8f80; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; }
  th:hover { color: #4ecb71; }
  td { padding: 8px 10px; border-bottom: 1px solid #1c2420; vertical-align: top; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tr:hover td { background: #1c2420; }
  .qtype { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .qtype-chat { background: #1a2e22; color: #6bc88a; }
  .qtype-search { background: #1a2230; color: #6ba8c8; }
  .empty { text-align: center; padding: 40px; color: #4e6055; }
  .back { display: inline-block; margin-bottom: 16px; color: #4ecb71; text-decoration: none; font-size: 13px; }
  .refresh { display: inline-block; margin-left: 16px; color: #4ecb71; text-decoration: none; font-size: 13px; }
</style>
</head>
<body>
  <a href="/" class="back">&larr; Back to search</a>
  <h1>Co<span>Bot</span> Admin <a href="/api/admin?tab=${activeTab}" class="refresh">Refresh</a></h1>
  <div class="tabs">
    <a href="/api/admin?tab=queries" class="tab ${activeTab === "queries" ? "active" : ""}">Query Log</a>
    <a href="/api/admin?tab=reports" class="tab ${activeTab === "reports" ? "active" : ""}">Reports</a>
  </div>

  ${activeTab === "queries" ? `
  <div class="summary">
    <div class="stat"><strong>${logs.length}</strong>Total queries</div>
    <div class="stat"><strong>${last24h.length}</strong>Last 24h</div>
    <div class="stat"><strong>${lastHour.length}</strong>Last hour</div>
    <div class="stat"><strong>${chatCount}</strong>Chat</div>
    <div class="stat"><strong>${searchCount}</strong>Search</div>
  </div>
  ${logs.length === 0
    ? '<div class="empty">No queries logged yet. Make sure KV_REST_API_URL and KV_REST_API_TOKEN are set.</div>'
    : `<table>
    <thead><tr>
      <th>Time</th><th>Type</th><th>Query</th><th>Location</th><th>Query Type</th><th>Results</th><th>IP</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
  ` : `
  <div class="empty">
    <p>Reports tab — use <a href="/admin" style="color:#4ecb71">/admin</a> for the local reports view, or check back here once reports are migrated to KV.</p>
  </div>
  `}

  <script>
    document.querySelectorAll("th").forEach((th, col) => {
      th.addEventListener("click", () => {
        const tbody = document.querySelector("tbody");
        if (!tbody) return;
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
    // Auto-refresh every 30 seconds
    setTimeout(() => location.reload(), 30000);
  </script>
</body>
</html>`;
}

function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}
