// Kompass logo: compass needle on a sky→indigo ring. Served publicly at
// /favicon.svg (data-free, like /healthz) and inlined in the page header.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="kg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs>
<circle cx="32" cy="32" r="30" fill="url(#kg)"/>
<circle cx="32" cy="32" r="24" fill="#0f172a"/>
<g stroke="#7dd3fc" stroke-width="2.5" stroke-linecap="round">
<line x1="32" y1="11" x2="32" y2="15" transform="rotate(45 32 32)"/>
<line x1="32" y1="11" x2="32" y2="15" transform="rotate(135 32 32)"/>
<line x1="32" y1="11" x2="32" y2="15" transform="rotate(225 32 32)"/>
<line x1="32" y1="11" x2="32" y2="15" transform="rotate(315 32 32)"/>
</g>
<polygon points="32,12 39,32 25,32" fill="#f43f5e"/>
<polygon points="32,52 25,32 39,32" fill="#e2e8f0"/>
<circle cx="32" cy="32" r="3.5" fill="#0f172a" stroke="#e2e8f0" stroke-width="1.5"/>
</svg>`;

// Read-only status page (SPEC P1 #10). The shell below contains zero data and no
// secrets — the bearer token is entered in-page, kept in localStorage, and every
// data fetch goes to the authenticated /status endpoint. See DECISIONS.md.
export const STATUS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kompass status</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<style>
  :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  body { margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
  h1 { font-size: 1.2rem; display: flex; align-items: center; gap: 0.5rem; }
  h1 img { width: 1.6rem; height: 1.6rem; }
  h2 { font-size: 1rem; margin-top: 1.6rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.25rem 0.6rem; border-bottom: 1px solid #8884; }
  .ok { color: #2a2; } .bad { color: #d33; } .warn { color: #c90; } .muted { opacity: 0.65; font-size: 0.85em; }
  .bar { display: inline-block; height: 0.6rem; background: #48f; vertical-align: middle; }
  .ubar { display: inline-block; width: 10rem; height: 0.6rem; background: #8882; border-radius: 3px; overflow: hidden; vertical-align: middle; margin-right: 0.4rem; }
  .ufill { display: block; height: 100%; } .ufill.ok2 { background: #2a2; } .ufill.warn { background: #c90; } .ufill.bad { background: #d33; }
  input { font: inherit; padding: 0.3rem; width: 24rem; max-width: 100%; }
  button { font: inherit; padding: 0.3rem 0.8rem; }
  #err { color: #d33; }
</style>
</head>
<body>
<h1><img src="/favicon.svg" alt="" /> Kompass status</h1>
<div id="login">
  <p>Bearer token (stored only in this browser's localStorage):</p>
  <input id="token" type="password" placeholder="KOMPASS_BEARER" />
  <button onclick="saveToken()">Load</button>
</div>
<p id="err"></p>
<div id="content"></div>
<script>
function saveToken() {
  localStorage.setItem('kompass_bearer', document.getElementById('token').value.trim());
  refresh();
}
async function refresh() {
  const token = localStorage.getItem('kompass_bearer');
  if (!token) return;
  document.getElementById('login').style.display = 'none';
  try {
    const res = await fetch('/status', { headers: { 'x-api-key': token } });
    if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 401 ? ' — bad token' : ''));
    const disc = await fetch('/discovery', { headers: { 'x-api-key': token } });
    render(await res.json(), disc.ok ? await disc.json() : null);
    document.getElementById('err').textContent = '';
  } catch (e) {
    document.getElementById('err').textContent = String(e);
    if (String(e).includes('401')) { localStorage.removeItem('kompass_bearer'); document.getElementById('login').style.display = ''; }
  }
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n ?? 0);
}
function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' kB';
  return (n ?? 0) + ' B';
}
function usageBar(used, limit) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const cls = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok2';
  return '<span class="ubar"><span class="ufill ' + cls + '" style="width:' + pct.toFixed(1) + '%"></span></span> ' +
    fmtTok(used) + ' / ' + fmtTok(limit) + ' <span class="muted">(' + pct.toFixed(1) + '%)</span>';
}
function render(d, disc) {
  let h = '';
  if (d.cloudflare) {
    const cf = d.cloudflare;
    const cpuBad = cf.workers.cpuTimeMsP99 >= cf.workers.cpuMsPerRequestLimit;
    h += '<h2>Cloudflare platform utilization <span style="font-weight:normal;font-size:0.75em">(Kompass’s own free-plan headroom — today, UTC)</span></h2>';
    h += '<table><tr><th></th><th>today</th><th>free-plan limit</th></tr>';
    h += '<tr><td>Workers requests</td><td colspan="2">' + usageBar(cf.workers.requests, cf.workers.requestsLimit) + '</td></tr>';
    h += '<tr><td>Worker CPU time / request</td><td colspan="2">p50 ' + cf.workers.cpuTimeMsP50 + 'ms · p99 ' +
      '<span class="' + (cpuBad ? 'bad' : '') + '">' + cf.workers.cpuTimeMsP99 + 'ms</span> (limit ' + cf.workers.cpuMsPerRequestLimit + 'ms/request)' +
      (cpuBad ? ' <span class="bad">⚠ some requests are hitting the CPU ceiling</span>' : '') + '</td></tr>';
    h += '<tr><td>Worker errors / subrequests today</td><td colspan="2">' + cf.workers.errors + ' errors, ' + cf.workers.subrequests + ' subrequests</td></tr>';
    h += '<tr><td>Durable Object requests</td><td colspan="2">' + fmtTok(cf.durableObjects.requests) + ' (' + cf.durableObjects.errors + ' errors), ' + (cf.durableObjects.wallTimeMsTotal / 1000).toFixed(1) + 's cumulative wall time</td></tr>';
    h += '<tr><td>KV reads</td><td colspan="2">' + usageBar(cf.kv.reads, cf.kv.readsLimit) + '</td></tr>';
    h += '<tr><td>KV writes</td><td colspan="2">' + usageBar(cf.kv.writes, cf.kv.writesLimit) + '</td></tr>';
    h += '<tr><td>KV storage</td><td colspan="2">' + fmtBytes(cf.kv.storageBytes) + ' / ' + fmtBytes(cf.kv.storageLimit) + '</td></tr>';
    h += '</table>';
  } else {
    h += '<h2>Cloudflare platform utilization</h2><p style="opacity:0.7">Not configured — set CLOUDFLARE_API_TOKEN (Account Analytics:Read scope) as a Worker secret to enable.</p>';
  }
  h += '<h2>Providers</h2><table><tr><th>provider</th><th>state</th><th>RPM</th><th>RPD</th><th>tokens today (in / out)</th></tr>';
  for (const [name, p] of Object.entries(d.providers)) {
    const state = !p.enabled ? 'disabled' : !p.has_key ? 'no key' : 'live';
    const pct = (u, l) => '<span class="bar" style="width:' + Math.min(100, (u / l) * 100) * 0.9 + 'px"></span> ' + u + '/' + l;
    const tok = p.tokens_today ?? { in: 0, out: 0 };
    h += '<tr><td>' + esc(name) + '</td><td class="' + (state === 'live' ? 'ok' : 'bad') + '">' + state + '</td>' +
         '<td>' + pct(p.rpm.used, p.rpm.limit) + '</td><td>' + pct(p.rpd.used, p.rpd.limit) + '</td>' +
         '<td>' + fmtTok(tok.in) + ' / ' + fmtTok(tok.out) + '</td></tr>';
  }
  h += '</table>';
  const depEntries = Object.entries(d.deprecated_models || {});
  if (depEntries.length) {
    h += '<h2>Deprecated models <span style="font-weight:normal;font-size:0.75em">(auto-substituted at every config push — never live, even if still listed in a lane)</span></h2>';
    h += '<table><tr><th>old</th><th>→ replaced by</th><th>since</th><th>note</th></tr>';
    for (const [old, info] of depEntries) {
      h += '<tr><td>' + esc(old) + '</td><td>' + esc(info.replaced_by) + '</td><td>' + esc(info.since || '') + '</td><td>' + esc(info.note || '') + '</td></tr>';
    }
    h += '</table>';
  }
  h += '<h2>Lanes</h2><table><tr><th>lane</th><th>spread</th><th>chain</th></tr>';
  for (const [lane, l] of Object.entries(d.lanes)) {
    h += '<tr><td>' + esc(lane) + (lane === d.default_lane ? ' *' : '') + '</td>' +
         '<td>' + (l.spread_top > 1 ? 'top ' + l.spread_top : '—') + '</td>' +
         '<td>' + l.chain.map(esc).join(' → ') + '</td></tr>';
  }
  h += '</table>';
  const perfEntries = Object.entries(d.perf || {}).sort((a, b) => a[1].rate - b[1].rate);
  if (perfEntries.length) {
    h += '<h2>Model reliability (recent)</h2><table><tr><th>model</th><th>success rate</th><th>ok/fail</th></tr>';
    for (const [entry, p] of perfEntries) {
      h += '<tr><td>' + esc(entry) + '</td><td class="' + (p.rate >= 80 ? 'ok' : p.rate >= 50 ? '' : 'bad') + '">' + p.rate + '%</td><td>' + p.ok + '/' + p.fail + '</td></tr>';
    }
    h += '</table>';
  }
  const cds = Object.entries(d.cooldowns);
  if (cds.length) {
    h += '<h2>Cooldowns</h2><table><tr><th>model</th><th>remaining</th></tr>' +
      cds.map(([m, t]) => '<tr><td>' + esc(m) + '</td><td>' + esc(t) + '</td></tr>').join('') + '</table>';
  }
  h += '<h2>Last ' + d.routes.length + ' routes</h2><table><tr><th>time</th><th>lane</th><th>model</th><th>ok</th><th>ms</th><th>tokens in/out</th><th>detail</th></tr>';
  for (const r of d.routes) {
    const tok = r.tin !== undefined ? fmtTok(r.tin) + ' / ' + fmtTok(r.tout) : '';
    // browser-local time, not UTC
    const t = new Date(r.ts).toLocaleTimeString([], { hour12: false });
    h += '<tr><td>' + t + '</td><td>' + esc(r.lane) + '</td><td>' + esc(r.entry) + '</td>' +
         '<td class="' + (r.ok ? 'ok' : 'bad') + '">' + (r.ok ? '✓' : '✗') + '</td><td>' + esc(r.ms ?? '') + '</td><td>' + tok + '</td><td>' + esc(r.detail ?? '') + '</td></tr>';
  }
  h += '</table>';
  if (disc) {
    const rows = Object.entries(disc.providers)
      .filter(([, p]) => p.error || p.newSinceLast.length || p.unconfigured.length);
    h += '<h2>Model discovery <span style="font-weight:normal;font-size:0.75em">(daily check, never auto-applied — last run ' +
      new Date(disc.ts).toLocaleString([], { hour12: false }) + ')</span></h2>';
    if (!rows.length) {
      h += '<p style="opacity:0.7">No new or unconfigured models detected.</p>';
    } else {
      h += '<table><tr><th>provider</th><th>🆕 new since last check</th><th>unconfigured (live but unused)</th></tr>';
      for (const [name, p] of rows) {
        h += '<tr><td>' + esc(name) + (p.error ? ' <span class="bad">(' + esc(p.error) + ')</span>' : '') + '</td>' +
             '<td>' + (p.newSinceLast.map(esc).join(', ') || '—') + '</td>' +
             '<td>' + (p.unconfigured.slice(0, 8).map(esc).join(', ') || '—') + (p.unconfigured.length > 8 ? ' …' : '') + '</td></tr>';
      }
      h += '</table>';
    }
  }
  document.getElementById('content').innerHTML = h;
}
refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
