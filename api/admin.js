const { getQueryLogs } = require("./_log");
const { Redis } = require("@upstash/redis");

const REPORTS_KEY = "cobot:reports";

async function getReports() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return [];
  const r = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  try {
    const raw = await r.lrange(REPORTS_KEY, 0, -1);
    return raw.map(entry => typeof entry === "string" ? JSON.parse(entry) : entry);
  } catch { return []; }
}

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
  const reports = tab === "reports" ? await getReports() : [];

  res.status(200).send(adminPage(logs, reports, tab));
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

function buildReportsTab(reports) {
  const deadCount = reports.filter(r => r.report_type === "dead_link").length;
  const irrelCount = reports.filter(r => r.report_type === "irrelevant").length;
  const feedbackCount = reports.filter(r => r.report_type === "feedback").length;

  const reportRows = reports.map(r => {
    const ts = r.timestamp ? r.timestamp.slice(0, 16).replace("T", " ") : "";
    const urlCell = r.primary_url
      ? '<a href="' + esc(r.primary_url) + '" target="_blank" style="color:#4ecb71">' + esc(truncate(r.primary_url, 40)) + '</a>'
      : "—";
    return '<tr data-id="' + esc(r.id) + '">'
      + "<td>" + esc(ts) + "</td>"
      + '<td><span class="qtype qtype-' + esc(r.report_type) + '">' + esc(r.report_type) + "</span></td>"
      + "<td>" + esc(r.profile_name || "—") + "</td>"
      + "<td>" + urlCell + "</td>"
      + "<td>" + esc(r.query || "—") + "</td>"
      + "<td>" + esc(r.message || "—") + "</td>"
      + "<td><button onclick=\"dismissReport('" + esc(r.id) + "', this)\">Dismiss</button></td>"
      + "</tr>";
  }).join("");

  let html = '<div class="summary">'
    + '<div class="stat"><strong>' + deadCount + '</strong>Dead links</div>'
    + '<div class="stat"><strong>' + irrelCount + '</strong>Irrelevant</div>'
    + '<div class="stat"><strong>' + feedbackCount + '</strong>Feedback</div>'
    + '<div class="stat"><strong>' + reports.length + '</strong>Total</div>'
    + '</div>';

  if (reports.length === 0) {
    html += '<div class="empty">No reports yet.</div>';
  } else {
    html += '<table><thead><tr>'
      + '<th>Time</th><th>Type</th><th>Profile</th><th>URL</th><th>Query</th><th>Message</th><th></th>'
      + '</tr></thead><tbody>' + reportRows + '</tbody></table>';
  }
  return html;
}

function adminPage(logs, reports, activeTab) {
  const now = new Date();
  const last24h = logs.filter(l => (now - new Date(l.ts)) < 86400000);
  const lastHour = logs.filter(l => (now - new Date(l.ts)) < 3600000);
  const chatCount = logs.filter(l => l.type === "chat").length;
  const searchCount = logs.filter(l => l.type === "search").length;

  const queryRows = logs.map(l => '<tr>'
    + '<td>' + esc(l.ts ? l.ts.slice(0, 19).replace("T", " ") : "") + '</td>'
    + '<td><span class="qtype qtype-' + esc(l.type) + '">' + esc(l.type) + '</span></td>'
    + '<td title="' + esc(l.query) + '">' + esc(truncate(l.query, 60)) + '</td>'
    + '<td>' + esc(Array.isArray(l.geo) ? l.geo.join(", ") : (l.geo || "")) + '</td>'
    + '<td>' + esc(l.queryType) + '</td>'
    + '<td>' + (l.resultCount || 0) + '</td>'
    + '<td>' + esc(l.ip) + '</td>'
    + '</tr>'
  ).join("");

  let tabContent;
  if (activeTab === "queries") {
    tabContent = '<div class="summary">'
      + '<div class="stat"><strong>' + logs.length + '</strong>Total queries</div>'
      + '<div class="stat"><strong>' + last24h.length + '</strong>Last 24h</div>'
      + '<div class="stat"><strong>' + lastHour.length + '</strong>Last hour</div>'
      + '<div class="stat"><strong>' + chatCount + '</strong>Chat</div>'
      + '<div class="stat"><strong>' + searchCount + '</strong>Search</div>'
      + '</div>';
    if (logs.length === 0) {
      tabContent += '<div class="empty">No queries logged yet.</div>';
    } else {
      tabContent += '<table><thead><tr>'
        + '<th>Time</th><th>Type</th><th>Query</th><th>Location</th><th>Query Type</th><th>Results</th><th>IP</th>'
        + '</tr></thead><tbody>' + queryRows + '</tbody></table>';
    }
  } else {
    tabContent = buildReportsTab(reports);
  }

  const queriesActive = activeTab === "queries" ? " active" : "";
  const reportsActive = activeTab === "reports" ? " active" : "";

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
    + '<meta charset="UTF-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
    + '<title>CoBot Admin</title>\n'
    + '<script async src="https://www.googletagmanager.com/gtag/js?id=G-LB5K7C4GGQ"></script>\n'
    + '<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","G-LB5K7C4GGQ");</script>\n'
    + '<style>\n'
    + '* { margin: 0; padding: 0; box-sizing: border-box; }\n'
    + 'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1210; color: #d4ddd6; padding: 24px; }\n'
    + 'h1 { font-size: 22px; margin-bottom: 16px; }\n'
    + 'h1 span { color: #4ecb71; }\n'
    + '.tabs { display: flex; gap: 8px; margin-bottom: 20px; }\n'
    + '.tab { padding: 8px 16px; background: #171d19; border: 1px solid #2a3630; border-radius: 6px; color: #7a8f80; text-decoration: none; font-size: 13px; }\n'
    + '.tab.active { background: #1c2e22; border-color: #4ecb71; color: #4ecb71; }\n'
    + '.tab:hover { border-color: #4ecb71; color: #d4ddd6; }\n'
    + '.summary { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }\n'
    + '.stat { padding: 12px 20px; background: #171d19; border: 1px solid #2a3630; border-radius: 8px; font-size: 14px; }\n'
    + '.stat strong { color: #4ecb71; font-size: 20px; display: block; margin-bottom: 2px; }\n'
    + 'table { width: 100%; border-collapse: collapse; font-size: 13px; }\n'
    + 'th { text-align: left; padding: 8px 10px; background: #171d19; border-bottom: 2px solid #2a3630; color: #7a8f80; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; }\n'
    + 'th:hover { color: #4ecb71; }\n'
    + 'td { padding: 8px 10px; border-bottom: 1px solid #1c2420; vertical-align: top; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n'
    + 'tr:hover td { background: #1c2420; }\n'
    + '.qtype { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }\n'
    + '.qtype-chat { background: #1a2e22; color: #6bc88a; }\n'
    + '.qtype-search { background: #1a2230; color: #6ba8c8; }\n'
    + '.qtype-dead_link { background: #3a1a1a; color: #e87070; }\n'
    + '.qtype-irrelevant { background: #3a3010; color: #d4a940; }\n'
    + '.qtype-feedback { background: #1a2e22; color: #6bc88a; }\n'
    + '.empty { text-align: center; padding: 40px; color: #4e6055; }\n'
    + '.back { display: inline-block; margin-bottom: 16px; color: #4ecb71; text-decoration: none; font-size: 13px; }\n'
    + '.refresh { display: inline-block; margin-left: 16px; color: #4ecb71; text-decoration: none; font-size: 13px; }\n'
    + 'button { padding: 4px 10px; background: #1c2420; border: 1px solid #2a3630; border-radius: 4px; color: #7a8f80; cursor: pointer; font-size: 12px; }\n'
    + 'button:hover { color: #e87070; border-color: #e87070; }\n'
    + '</style>\n</head>\n<body>\n'
    + '<a href="/" class="back">&larr; Back to search</a>\n'
    + '<h1>Co<span>Bot</span> Admin <a href="/api/admin?tab=' + activeTab + '" class="refresh">Refresh</a></h1>\n'
    + '<div class="tabs">\n'
    + '<a href="/api/admin?tab=queries" class="tab' + queriesActive + '">Query Log</a>\n'
    + '<a href="/api/admin?tab=reports" class="tab' + reportsActive + '">Reports</a>\n'
    + '</div>\n'
    + tabContent
    + '\n<script>\n'
    + 'document.querySelectorAll("th").forEach((th, col) => {\n'
    + '  th.addEventListener("click", () => {\n'
    + '    const tbody = document.querySelector("tbody");\n'
    + '    if (!tbody) return;\n'
    + '    const rows = [...tbody.querySelectorAll("tr")];\n'
    + '    const dir = th.dataset.dir === "asc" ? "desc" : "asc";\n'
    + '    th.dataset.dir = dir;\n'
    + '    rows.sort((a, b) => {\n'
    + '      const at = a.children[col]?.textContent || "";\n'
    + '      const bt = b.children[col]?.textContent || "";\n'
    + '      return dir === "asc" ? at.localeCompare(bt) : bt.localeCompare(at);\n'
    + '    });\n'
    + '    rows.forEach(r => tbody.appendChild(r));\n'
    + '  });\n'
    + '});\n'
    + 'async function dismissReport(id, btn) {\n'
    + '  if (!confirm("Dismiss this report?")) return;\n'
    + '  const res = await fetch("/api/reports/" + id, { method: "DELETE" });\n'
    + '  if (res.ok) btn.closest("tr").remove();\n'
    + '}\n'
    + 'setTimeout(() => location.reload(), 30000);\n'
    + '</script>\n</body>\n</html>';
}

function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}
