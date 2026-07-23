// Read-only status page (SPEC P1 #10). The shell below contains zero data and no
// secrets — the bearer token is entered in-page, kept in localStorage, and every
// data fetch goes to the authenticated /status endpoint. See DECISIONS.md.
export const STATUS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kompass status</title>
<style>
  :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  body { margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 1.6rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.25rem 0.6rem; border-bottom: 1px solid #8884; }
  .ok { color: #2a2; } .bad { color: #d33; }
  .bar { display: inline-block; height: 0.6rem; background: #48f; vertical-align: middle; }
  input { font: inherit; padding: 0.3rem; width: 24rem; max-width: 100%; }
  button { font: inherit; padding: 0.3rem 0.8rem; }
  #err { color: #d33; }
</style>
</head>
<body>
<h1>🧭 Kompass status</h1>
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
    render(await res.json());
    document.getElementById('err').textContent = '';
  } catch (e) {
    document.getElementById('err').textContent = String(e);
    if (String(e).includes('401')) { localStorage.removeItem('kompass_bearer'); document.getElementById('login').style.display = ''; }
  }
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function render(d) {
  let h = '<h2>Providers</h2><table><tr><th>provider</th><th>state</th><th>RPM</th><th>RPD</th></tr>';
  for (const [name, p] of Object.entries(d.providers)) {
    const state = !p.enabled ? 'disabled' : !p.has_key ? 'no key' : 'live';
    const pct = (u, l) => '<span class="bar" style="width:' + Math.min(100, (u / l) * 100) * 0.9 + 'px"></span> ' + u + '/' + l;
    h += '<tr><td>' + esc(name) + '</td><td class="' + (state === 'live' ? 'ok' : 'bad') + '">' + state + '</td>' +
         '<td>' + pct(p.rpm.used, p.rpm.limit) + '</td><td>' + pct(p.rpd.used, p.rpd.limit) + '</td></tr>';
  }
  h += '</table><h2>Lanes</h2><table><tr><th>lane</th><th>chain</th></tr>';
  for (const [lane, chain] of Object.entries(d.lanes)) {
    h += '<tr><td>' + esc(lane) + (lane === d.default_lane ? ' *' : '') + '</td><td>' + chain.map(esc).join(' → ') + '</td></tr>';
  }
  h += '</table>';
  const cds = Object.entries(d.cooldowns);
  if (cds.length) {
    h += '<h2>Cooldowns</h2><table><tr><th>model</th><th>remaining</th></tr>' +
      cds.map(([m, t]) => '<tr><td>' + esc(m) + '</td><td>' + esc(t) + '</td></tr>').join('') + '</table>';
  }
  h += '<h2>Last ' + d.routes.length + ' routes</h2><table><tr><th>time</th><th>lane</th><th>model</th><th>ok</th><th>ms</th><th>detail</th></tr>';
  for (const r of d.routes) {
    h += '<tr><td>' + new Date(r.ts).toISOString().slice(11, 19) + '</td><td>' + esc(r.lane) + '</td><td>' + esc(r.entry) + '</td>' +
         '<td class="' + (r.ok ? 'ok' : 'bad') + '">' + (r.ok ? '✓' : '✗') + '</td><td>' + esc(r.ms ?? '') + '</td><td>' + esc(r.detail ?? '') + '</td></tr>';
  }
  h += '</table>';
  document.getElementById('content').innerHTML = h;
}
refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
