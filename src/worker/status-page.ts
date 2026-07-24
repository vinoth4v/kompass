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

// Read-only status dashboard (redesigned 2026-07-24). The shell contains zero
// data and no secrets — the bearer is entered in-page, kept in localStorage, and
// every data fetch hits the authenticated /status endpoint. Tabs instead of one
// long page; the Analytics tab renders daily/monthly consumption and model usage
// from the DO's per-day history aggregates as self-contained inline SVG (no
// external libs — Worker-served, no CDN). Chart colors are a CVD-validated
// 5-slot dark palette (dataviz-checked against the card surface #121828); the
// neutral gray is the "Other" fold, and status colors are reserved for quota
// meters. NOTE: the embedded script deliberately avoids backticks/template
// literals — it lives inside this TS template string.
export const STATUS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kompass — dashboard</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0d14; --bg2: #0e1320; --card: #121828; --line: #1e2433;
    --ink: #e8eaf0; --muted: #8b95a7; --faint: #5b657a;
    --s1: #3987e5; --s2: #199e70; --s3: #c98500; --s4: #9085e9; --s5: #e66767;
    --other: #5c6678;
    --good: #0ca30c; --warn: #fab219; --serious: #ec835a; --crit: #d03b3b;
    --accent: #38bdf8;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14.5px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  header {
    position: sticky; top: 0; z-index: 20; background: #0a0d14ee;
    backdrop-filter: blur(6px); border-bottom: 1px solid var(--line);
  }
  .hrow {
    max-width: 76rem; margin: 0 auto; padding: 0.65rem 1.2rem;
    display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap;
  }
  .hrow img { width: 1.7rem; height: 1.7rem; }
  .hrow h1 { font-size: 1.05rem; margin: 0; font-weight: 700; }
  .hrow h1 span { color: #f5a524; }
  .live { display: flex; align-items: center; gap: 0.4rem; color: var(--muted); font-size: 0.8rem; margin-left: auto; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); animation: pulse 2s infinite; }
  .dot.err { background: var(--crit); animation: none; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  nav.tabs { max-width: 76rem; margin: 0 auto; padding: 0 1.2rem; display: flex; gap: 0.15rem; overflow-x: auto; }
  nav.tabs button {
    background: none; border: none; color: var(--muted); font: inherit; font-size: 0.9rem;
    padding: 0.5rem 0.85rem; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap;
  }
  nav.tabs button:hover { color: var(--ink); }
  nav.tabs button.active { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
  main { max-width: 76rem; margin: 0 auto; padding: 1.2rem; }
  section.tab { display: none; }
  section.tab.active { display: block; }
  .grid { display: grid; gap: 0.9rem; }
  .tiles { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  .cards2 { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 0.9rem 1rem; min-width: 0; }
  .card h3 { margin: 0 0 0.5rem; font-size: 0.82rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .tile .v { font-size: 1.7rem; font-weight: 700; line-height: 1.15; }
  .tile .s { color: var(--muted); font-size: 0.8rem; margin-top: 0.15rem; }
  .tile .d { font-size: 0.8rem; margin-top: 0.2rem; }
  .up { color: var(--good); } .down { color: var(--serious); }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.32rem 0.55rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.05em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .ok { color: var(--good); } .bad { color: var(--crit); } .warnc { color: var(--warn); }
  .chip { display: inline-block; padding: 0.05rem 0.5rem; border-radius: 99px; font-size: 0.72rem; font-weight: 600; background: var(--bg2); border: 1px solid var(--line); color: var(--muted); }
  .meterwrap { display: flex; align-items: center; gap: 0.55rem; }
  .meter { flex: 1; height: 8px; background: var(--bg2); border-radius: 5px; overflow: hidden; min-width: 60px; }
  .meter i { display: block; height: 100%; border-radius: 5px; }
  .mtext { font-size: 0.78rem; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .legend { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; margin: 0.25rem 0 0.5rem; font-size: 0.78rem; color: var(--muted); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 0.35rem; vertical-align: -1px; }
  /* Charts scroll sideways on narrow screens instead of scaling text illegibly:
     the SVG keeps a readable minimum width inside its own scroll container. */
  .chart .plot { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .chart .plot svg { min-width: 660px; width: 100%; height: auto; display: block; }
  .chart rect.seg, .chart path.seg { cursor: default; }
  .chart rect.seg:hover, .chart path.seg:hover { opacity: 0.85; }
  .range { display: flex; gap: 0.3rem; margin-bottom: 0.9rem; }
  .range button { background: var(--card); border: 1px solid var(--line); color: var(--muted); font: inherit; font-size: 0.8rem; padding: 0.25rem 0.7rem; border-radius: 8px; cursor: pointer; }
  .range button.active { color: var(--ink); border-color: var(--accent); background: #38bdf81a; }
  details.dtable { margin-top: 0.5rem; font-size: 0.8rem; }
  details.dtable summary { color: var(--faint); cursor: pointer; }
  .hbar { display: grid; grid-template-columns: minmax(140px, 34%) 1fr auto; gap: 0.5rem; align-items: center; padding: 0.18rem 0; }
  .hbar .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.82rem; }
  .hbar .b { height: 12px; background: var(--bg2); border-radius: 4px; overflow: hidden; }
  .hbar .b i { display: block; height: 100%; background: var(--s1); border-radius: 4px 4px 4px 4px; }
  .hbar .c { font-size: 0.78rem; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  #tip { position: fixed; pointer-events: none; background: #0e1320f2; border: 1px solid var(--line); border-radius: 8px; padding: 0.45rem 0.6rem; font-size: 0.78rem; z-index: 50; display: none; max-width: 260px; box-shadow: 0 6px 20px #0008; }
  #tip b { display: block; margin-bottom: 0.15rem; }
  #login { max-width: 26rem; margin: 4rem auto; text-align: center; }
  #login input { font: inherit; padding: 0.5rem 0.7rem; width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 8px; color: var(--ink); margin: 0.6rem 0; }
  #login button { font: inherit; padding: 0.45rem 1.2rem; background: var(--accent); color: #06202e; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; }
  #err { color: var(--crit); max-width: 76rem; margin: 0.5rem auto; padding: 0 1.2rem; }
  .muted { color: var(--muted); } .small { font-size: 0.8rem; }
  .scrollx { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  h2.sec { font-size: 0.95rem; margin: 1.4rem 0 0.6rem; }
  @media (max-width: 700px) {
    main { padding: 0.8rem; }
    .hrow { padding: 0.55rem 0.8rem; gap: 0.5rem; }
    .hrow h1 { font-size: 0.98rem; }
    nav.tabs { padding: 0 0.5rem; }
    nav.tabs button { padding: 0.45rem 0.65rem; font-size: 0.85rem; }
    .card { padding: 0.7rem 0.75rem; border-radius: 10px; }
    .grid { gap: 0.6rem; }
    .tiles { grid-template-columns: repeat(2, 1fr); }
    .tile .v { font-size: 1.35rem; }
    .hbar { grid-template-columns: minmax(90px, 32%) 1fr auto; gap: 0.4rem; }
    .range { flex-wrap: wrap; }
    h2.sec { margin: 1.1rem 0 0.5rem; }
    table { font-size: 0.8rem; }
    th, td { padding: 0.28rem 0.4rem; }
    .meter { min-width: 46px; }
  }
</style>
</head>
<body>
<header>
  <div class="hrow">
    <img src="/favicon.svg" alt="" />
    <h1>Kom<span>pass</span> <span style="color:var(--muted);font-weight:400;font-size:0.85rem">dashboard</span></h1>
    <div class="live"><span class="dot" id="dot"></span><span id="upd">connecting…</span></div>
  </div>
  <nav class="tabs" id="tabs" style="display:none">
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="analytics">Analytics</button>
    <button data-tab="models">Models</button>
    <button data-tab="routes">Routes</button>
    <button data-tab="config">Config</button>
    <button data-tab="platform">Platform</button>
  </nav>
</header>
<p id="err"></p>
<div id="login">
  <p>Bearer token (stored only in this browser's localStorage):</p>
  <input id="token" type="password" placeholder="KOMPASS_BEARER" />
  <button onclick="saveToken()">Open dashboard</button>
</div>
<main id="main" style="display:none">
  <section class="tab active" id="tab-overview"></section>
  <section class="tab" id="tab-analytics"></section>
  <section class="tab" id="tab-models"></section>
  <section class="tab" id="tab-routes"></section>
  <section class="tab" id="tab-config"></section>
  <section class="tab" id="tab-platform"></section>
</main>
<div id="tip"></div>
<script>
var SERIES = ['#3987e5', '#199e70', '#c98500', '#9085e9', '#e66767'];
var OTHER = '#5c6678';
var DATA = null, DISC = null, RANGE = Number(localStorage.getItem('kompass_range') || 30);

function saveToken() {
  localStorage.setItem('kompass_bearer', document.getElementById('token').value.trim());
  refresh();
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function fmt(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' kB';
  return (n || 0) + ' B';
}
function utcDay(offsetDays) {
  var d = new Date(Date.now() - (offsetDays || 0) * 86400000);
  return d.toISOString().slice(0, 10);
}
function lastDays(n) {
  var out = [];
  for (var i = n - 1; i >= 0; i--) out.push(utcDay(i));
  return out;
}
function emptyDay() { return { providers: {}, models: {}, lanes: {} }; }
function meter(used, limit) {
  var pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  var col = pct >= 90 ? 'var(--crit)' : pct >= 70 ? 'var(--warn)' : 'var(--good)';
  var icon = pct >= 90 ? '⛔ ' : pct >= 70 ? '⚠ ' : '';
  return '<div class="meterwrap"><span class="meter"><i style="width:' + pct.toFixed(1) + '%;background:' + col + '"></i></span>' +
    '<span class="mtext">' + icon + fmt(used) + ' / ' + fmt(limit) + ' (' + pct.toFixed(0) + '%)</span></div>';
}
function tile(label, value, sub, delta) {
  return '<div class="card tile"><h3>' + esc(label) + '</h3><div class="v">' + value + '</div>' +
    (sub ? '<div class="s">' + sub + '</div>' : '') + (delta || '') + '</div>';
}

/* ---- tooltip ---- */
var tipEl;
document.addEventListener('mousemove', function (e) {
  var t = e.target.closest ? e.target.closest('[data-tip]') : null;
  tipEl = tipEl || document.getElementById('tip');
  if (t) {
    tipEl.innerHTML = t.getAttribute('data-tip');
    tipEl.style.display = 'block';
    var x = Math.min(e.clientX + 14, window.innerWidth - 280);
    tipEl.style.left = x + 'px';
    tipEl.style.top = (e.clientY + 14) + 'px';
  } else {
    tipEl.style.display = 'none';
  }
});

/* ---- stacked daily bar chart (inline SVG, no libs) ----
   days: ['YYYY-MM-DD'...], names: series names (last may be Other),
   matrix: matrix[dayIdx][seriesIdx] = value, colors aligned with names. */
function stackChart(days, names, matrix, colors, unitLabel) {
  var W = 920, H = 230, padL = 46, padR = 6, padT = 12, padB = 26;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var totals = matrix.map(function (row) { return row.reduce(function (a, b) { return a + b; }, 0); });
  var max = Math.max(1, Math.max.apply(null, totals));
  // nice ceiling: 1/2/5 * 10^k
  var pow = Math.pow(10, Math.floor(Math.log10(max)));
  var niceMax = [1, 2, 5, 10].map(function (m) { return m * pow; }).filter(function (v) { return v >= max; })[0] || max;
  var n = days.length;
  var slot = plotW / n;
  var barW = Math.max(3, Math.min(26, slot * 0.66));
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';
  // recessive gridlines + y labels (skip the mid tick when it wouldn't be a
  // whole number — a "0.5 requests" gridline is noise on tiny ranges)
  var fracs = niceMax / 2 === Math.floor(niceMax / 2) || niceMax >= 10 ? [0, 0.5, 1] : [0, 1];
  fracs.forEach(function (f) {
    var y = padT + plotH - f * plotH;
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#1e2433" stroke-width="1"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10" fill="#8b95a7" style="font-variant-numeric:tabular-nums">' + fmt(niceMax * f) + '</text>';
  });
  var labelEvery = Math.ceil(n / 9);
  for (var i = 0; i < n; i++) {
    var x = padL + i * slot + (slot - barW) / 2;
    var yCursor = padT + plotH;
    var tip = '<b>' + days[i] + '</b>';
    for (var s = 0; s < names.length; s++) {
      if (matrix[i][s]) tip += esc(names[s]) + ': ' + fmt(matrix[i][s]) + '<br>';
    }
    tip += 'total: ' + fmt(totals[i]) + (unitLabel ? ' ' + unitLabel : '');
    // find topmost non-zero segment for the rounded cap
    var topIdx = -1;
    for (var s2 = names.length - 1; s2 >= 0; s2--) { if (matrix[i][s2] > 0) { topIdx = s2; break; } }
    for (var s3 = 0; s3 < names.length; s3++) {
      var v = matrix[i][s3];
      if (!v) continue;
      var h = (v / niceMax) * plotH;
      var gap = s3 === topIdx ? 0 : 2; // 2px surface gap between stacked segments
      var segH = Math.max(1, h - gap);
      var y = yCursor - h;
      if (s3 === topIdx && segH > 3) {
        var r = Math.min(3.5, barW / 2);
        svg += '<path class="seg" data-tip="' + tip + '" fill="' + colors[s3] + '" d="M' + x + ' ' + (y + segH) +
          'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y +
          'H' + (x + barW - r) + 'Q' + (x + barW) + ' ' + y + ' ' + (x + barW) + ' ' + (y + r) +
          'V' + (y + segH) + 'Z"/>';
      } else {
        svg += '<rect class="seg" data-tip="' + tip + '" x="' + x + '" y="' + y + '" width="' + barW + '" height="' + segH + '" fill="' + colors[s3] + '"/>';
      }
      yCursor -= h;
    }
    if (i % labelEvery === 0) {
      svg += '<text x="' + (x + barW / 2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#8b95a7">' + days[i].slice(5) + '</text>';
    }
  }
  // baseline
  svg += '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '" stroke="#2a3346" stroke-width="1"/>';
  svg += '</svg>';
  return svg;
}
function legendHtml(names, colors) {
  return '<div class="legend">' + names.map(function (nm, i) {
    return '<span><i style="background:' + colors[i] + '"></i>' + esc(nm) + '</span>';
  }).join('') + '</div>';
}
function dataTable(days, names, matrix) {
  var h = '<details class="dtable"><summary>data table</summary><div class="scrollx"><table><tr><th>day</th>';
  names.forEach(function (nm) { h += '<th class="num">' + esc(nm) + '</th>'; });
  h += '<th class="num">total</th></tr>';
  for (var i = 0; i < days.length; i++) {
    var tot = matrix[i].reduce(function (a, b) { return a + b; }, 0);
    if (!tot) continue;
    h += '<tr><td>' + days[i] + '</td>';
    matrix[i].forEach(function (v) { h += '<td class="num">' + fmt(v) + '</td>'; });
    h += '<td class="num">' + fmt(tot) + '</td></tr>';
  }
  return h + '</table></div></details>';
}

/* ---- analytics data shaping ---- */
function rangeAgg(days) {
  var hist = (DATA && DATA.history) || {};
  var provTotals = {};
  days.forEach(function (day) {
    var cell = hist[day] || emptyDay();
    Object.keys(cell.providers).forEach(function (p) {
      provTotals[p] = (provTotals[p] || 0) + cell.providers[p].req;
    });
  });
  var top = Object.keys(provTotals).sort(function (a, b) { return provTotals[b] - provTotals[a]; }).slice(0, 5);
  var hasOther = Object.keys(provTotals).length > top.length;
  var names = top.concat(hasOther ? ['Other'] : []);
  var colors = top.map(function (_, i) { return SERIES[i]; }).concat(hasOther ? [OTHER] : []);
  var reqM = days.map(function (day) {
    var cell = hist[day] || emptyDay();
    var row = top.map(function (p) { return cell.providers[p] ? cell.providers[p].req : 0; });
    if (hasOther) {
      var other = 0;
      Object.keys(cell.providers).forEach(function (p) { if (top.indexOf(p) < 0) other += cell.providers[p].req; });
      row.push(other);
    }
    return row;
  });
  var tokM = days.map(function (day) {
    var cell = hist[day] || emptyDay(), tin = 0, tout = 0;
    Object.keys(cell.providers).forEach(function (p) { tin += cell.providers[p].tin; tout += cell.providers[p].tout; });
    return [tin, tout];
  });
  return { names: names, colors: colors, reqM: reqM, tokM: tokM };
}
function monthAgg() {
  var hist = (DATA && DATA.history) || {};
  var months = {};
  Object.keys(hist).forEach(function (day) {
    var m = day.slice(0, 7);
    var agg = (months[m] = months[m] || { req: 0, ok: 0, tin: 0, tout: 0 });
    Object.keys(hist[day].providers).forEach(function (p) {
      var s = hist[day].providers[p];
      agg.req += s.req; agg.ok += s.ok; agg.tin += s.tin; agg.tout += s.tout;
    });
  });
  return months;
}
function modelAgg(days) {
  var hist = (DATA && DATA.history) || {};
  var models = {};
  days.forEach(function (day) {
    var cell = hist[day] || emptyDay();
    Object.keys(cell.models).forEach(function (m) {
      var agg = (models[m] = models[m] || { req: 0, ok: 0 });
      agg.req += cell.models[m].req; agg.ok += cell.models[m].ok;
    });
  });
  return models;
}

/* ---- tab renderers ---- */
function renderOverview() {
  var d = DATA;
  var today = (d.history || {})[utcDay(0)] || emptyDay();
  var req = 0, ok = 0, tin = 0, tout = 0;
  Object.keys(today.providers).forEach(function (p) {
    var s = today.providers[p];
    req += s.req; ok += s.ok; tin += s.tin; tout += s.tout;
  });
  var yesterday = (d.history || {})[utcDay(1)] || emptyDay();
  var yReq = 0;
  Object.keys(yesterday.providers).forEach(function (p) { yReq += yesterday.providers[p].req; });
  var delta = yReq ? Math.round(((req - yReq) / yReq) * 100) : null;
  var cools = Object.keys(d.cooldowns || {}).length;
  var h = '<div class="grid tiles">';
  h += tile('Requests today', fmt(req), 'vs ' + fmt(yReq) + ' yesterday',
    delta === null ? '' : '<div class="d ' + (delta >= 0 ? 'up' : 'down') + '">' + (delta >= 0 ? '▲ +' : '▼ ') + delta + '%</div>');
  h += tile('Success rate today', req ? Math.round((ok / req) * 100) + '%' : '—', ok + ' ok / ' + (req - ok) + ' failed');
  h += tile('Tokens in today', fmt(tin), 'prompt tokens routed');
  h += tile('Tokens out today', fmt(tout), 'completion tokens');
  h += tile('Cooldowns', String(cools), cools ? 'models resting after failures' : 'all models healthy');
  h += '</div>';

  h += '<h2 class="sec">Provider quota (today, UTC)</h2><div class="card scrollx"><table><tr><th>provider</th><th>state</th><th style="min-width:190px">requests / day</th><th style="min-width:150px">requests / min</th><th class="num">tokens in</th><th class="num">tokens out</th></tr>';
  Object.keys(d.providers).forEach(function (name) {
    var p = d.providers[name];
    var state = !p.enabled ? '<span class="chip">disabled</span>' : !p.has_key ? '<span class="chip bad">no key</span>' : '<span class="chip ok">live</span>';
    var tok = p.tokens_today || { in: 0, out: 0 };
    h += '<tr><td class="mono">' + esc(name) + '</td><td>' + state + '</td><td>' + meter(p.rpd.used, p.rpd.limit) + '</td><td>' + meter(p.rpm.used, p.rpm.limit) + '</td>' +
      '<td class="num">' + fmt(tok.in) + '</td><td class="num">' + fmt(tok.out) + '</td></tr>';
  });
  h += '</table></div>';

  var cds = Object.keys(d.cooldowns || {});
  if (cds.length) {
    h += '<h2 class="sec">Active cooldowns</h2><div class="card"><table><tr><th>model</th><th>remaining</th></tr>' +
      cds.map(function (m) { return '<tr><td class="mono">' + esc(m) + '</td><td>' + esc(d.cooldowns[m]) + '</td></tr>'; }).join('') + '</table></div>';
  }
  document.getElementById('tab-overview').innerHTML = h;
}

function renderAnalytics() {
  var days = lastDays(RANGE);
  var agg = rangeAgg(days);
  var months = monthAgg();
  var mKeys = Object.keys(months).sort();
  var thisM = mKeys[mKeys.length - 1], prevM = mKeys[mKeys.length - 2];
  var tm = months[thisM] || { req: 0, ok: 0, tin: 0, tout: 0 };
  var pm = prevM ? months[prevM] : null;

  var h = '<div class="range">' + [7, 14, 30, 60].map(function (r) {
    return '<button data-range="' + r + '"' + (r === RANGE ? ' class="active"' : '') + '>' + r + 'd</button>';
  }).join('') + '<span class="muted small" style="align-self:center;margin-left:0.5rem">daily aggregates, UTC · 60-day retention</span></div>';

  h += '<div class="grid tiles">';
  h += tile('This month · requests', fmt(tm.req), thisM || '',
    pm ? '<div class="d ' + (tm.req >= pm.req ? 'up' : 'down') + '">' + (pm.req ? (tm.req >= pm.req ? '▲ +' : '▼ ') + Math.round(((tm.req - pm.req) / pm.req) * 100) + '% vs ' + prevM : '') + '</div>' : '');
  h += tile('This month · tokens in', fmt(tm.tin), pm ? 'last month: ' + fmt(pm.tin) : '');
  h += tile('This month · tokens out', fmt(tm.tout), pm ? 'last month: ' + fmt(pm.tout) : '');
  h += tile('This month · success', tm.req ? Math.round((tm.ok / tm.req) * 100) + '%' : '—', pm && pm.req ? 'last month: ' + Math.round((pm.ok / pm.req) * 100) + '%' : '');
  h += '</div>';

  h += '<h2 class="sec">Daily requests by provider</h2><div class="card chart">';
  if (agg.names.length) {
    h += legendHtml(agg.names, agg.colors);
    h += '<div class="plot">' + stackChart(days, agg.names, agg.reqM, agg.colors, 'requests') + '</div>';
    h += dataTable(days, agg.names, agg.reqM);
  } else {
    h += '<p class="muted">No traffic recorded yet — history starts accumulating with the first routed request.</p>';
  }
  h += '</div>';

  h += '<h2 class="sec">Daily token consumption</h2><div class="card chart">';
  h += legendHtml(['input tokens', 'output tokens'], [SERIES[0], SERIES[1]]);
  h += '<div class="plot">' + stackChart(days, ['input tokens', 'output tokens'], agg.tokM, [SERIES[0], SERIES[1]], 'tokens') + '</div>';
  h += dataTable(days, ['in', 'out'], agg.tokM);
  h += '</div>';
  document.getElementById('tab-analytics').innerHTML = h;
  document.querySelectorAll('#tab-analytics [data-range]').forEach(function (b) {
    b.addEventListener('click', function () {
      RANGE = Number(b.getAttribute('data-range'));
      localStorage.setItem('kompass_range', String(RANGE));
      renderAnalytics(); renderModels();
    });
  });
}

function renderModels() {
  var days = lastDays(RANGE);
  var models = modelAgg(days);
  var keys = Object.keys(models).sort(function (a, b) { return models[b].req - models[a].req; });
  var max = keys.length ? models[keys[0]].req : 1;
  var h = '<h2 class="sec" style="margin-top:0">Model usage · last ' + RANGE + ' days</h2><div class="card">';
  if (!keys.length) h += '<p class="muted">No usage recorded in this window yet.</p>';
  keys.slice(0, 20).forEach(function (m) {
    var s = models[m];
    var okPct = Math.round((s.ok / s.req) * 100);
    h += '<div class="hbar"><span class="n mono" title="' + esc(m) + '">' + esc(m) + '</span>' +
      '<span class="b" data-tip="<b>' + esc(m) + '</b>' + fmt(s.req) + ' requests · ' + okPct + '% ok"><i style="width:' + Math.max(1.5, (s.req / max) * 100) + '%"></i></span>' +
      '<span class="c">' + fmt(s.req) + ' · <span class="' + (okPct >= 80 ? 'ok' : okPct >= 50 ? 'warnc' : 'bad') + '">' + okPct + '%</span></span></div>';
  });
  if (keys.length > 20) h += '<p class="muted small">+ ' + (keys.length - 20) + ' more models with traffic</p>';
  h += '</div>';

  var perf = Object.keys(DATA.perf || {}).sort(function (a, b) { return DATA.perf[a].rate - DATA.perf[b].rate; });
  if (perf.length) {
    h += '<h2 class="sec">Recent reliability (decayed success rate)</h2><div class="card scrollx"><table><tr><th>model</th><th class="num">rate</th><th class="num">ok</th><th class="num">fail</th></tr>';
    perf.forEach(function (m) {
      var p = DATA.perf[m];
      h += '<tr><td class="mono">' + esc(m) + '</td><td class="num ' + (p.rate >= 80 ? 'ok' : p.rate >= 50 ? 'warnc' : 'bad') + '">' + p.rate + '%</td><td class="num">' + p.ok + '</td><td class="num">' + p.fail + '</td></tr>';
    });
    h += '</table></div>';
  }
  document.getElementById('tab-models').innerHTML = h;
}

function renderRoutes() {
  var d = DATA;
  var h = '<h2 class="sec" style="margin-top:0">Last ' + d.routes.length + ' routes</h2><div class="card scrollx"><table><tr><th>time</th><th>lane</th><th>model</th><th>ok</th><th class="num">ms</th><th class="num">tokens</th><th>detail</th></tr>';
  d.routes.forEach(function (r) {
    var t = new Date(r.ts).toLocaleTimeString([], { hour12: false });
    var tok = r.tin !== undefined ? fmt(r.tin) + ' / ' + fmt(r.tout) : '';
    h += '<tr><td class="mono">' + t + '</td><td><span class="chip">' + esc(r.lane) + '</span></td><td class="mono">' + esc(r.entry) + '</td>' +
      '<td class="' + (r.ok ? 'ok' : 'bad') + '">' + (r.ok ? '✓' : '✗') + '</td><td class="num">' + (r.ms == null ? '' : r.ms) + '</td><td class="num">' + tok + '</td>' +
      '<td class="small muted">' + esc(r.detail || '') + '</td></tr>';
  });
  h += '</table></div>';
  document.getElementById('tab-routes').innerHTML = h;
}

function chainHtml(chain, disabledSet) {
  return chain.map(function (e) {
    return disabledSet.has(e)
      ? '<span class="muted" style="text-decoration:line-through" data-tip="disabled via kompass models enable">' + esc(e) + '</span>'
      : esc(e);
  }).join(' → ');
}
function renderConfig() {
  var d = DATA;
  var disabledSet = new Set(d.disabled_models || []);
  var h = '<h2 class="sec" style="margin-top:0">Lanes</h2><div class="card scrollx"><table><tr><th>lane</th><th>spread</th><th>chain</th></tr>';
  Object.keys(d.lanes).forEach(function (lane) {
    var l = d.lanes[lane];
    h += '<tr><td><span class="chip">' + esc(lane) + (lane === d.default_lane ? ' ★' : '') + '</span></td>' +
      '<td>' + (l.spread_top > 1 ? 'top ' + l.spread_top : '—') + '</td>' +
      '<td class="mono small">' + chainHtml(l.chain, disabledSet) + '</td></tr>';
  });
  h += '</table></div>';
  if (disabledSet.size) {
    h += '<h2 class="sec">Disabled models <span class="muted small">(kept in lanes.yaml, never tried — re-enable with <code>kompass models enable</code>)</span></h2><div class="card"><table><tr><th>model</th></tr>';
    Array.from(disabledSet).forEach(function (m) {
      h += '<tr><td class="mono">' + esc(m) + '</td></tr>';
    });
    h += '</table></div>';
  }
  var dep = Object.keys(d.deprecated_models || {});
  if (dep.length) {
    h += '<h2 class="sec">Deprecated models <span class="muted small">(auto-substituted at every config push)</span></h2><div class="card scrollx"><table><tr><th>old</th><th>replaced by</th><th>since</th><th>note</th></tr>';
    dep.forEach(function (old) {
      var info = d.deprecated_models[old];
      h += '<tr><td class="mono">' + esc(old) + '</td><td class="mono">' + esc(info.replaced_by) + '</td><td>' + esc(info.since || '') + '</td><td class="muted">' + esc(info.note || '') + '</td></tr>';
    });
    h += '</table></div>';
  }
  if (DISC) {
    var rows = Object.keys(DISC.providers).filter(function (p) {
      var x = DISC.providers[p];
      return x.error || x.newSinceLast.length || x.unconfigured.length;
    });
    h += '<h2 class="sec">Model discovery <span class="muted small">(daily, detect-only · last run ' + new Date(DISC.ts).toLocaleString([], { hour12: false }) + ')</span></h2>';
    if (!rows.length) h += '<div class="card"><p class="muted" style="margin:0">No new or unconfigured models detected.</p></div>';
    else {
      h += '<div class="card scrollx"><table><tr><th>provider</th><th>new since last check</th><th>live but unused</th></tr>';
      rows.forEach(function (name) {
        var p = DISC.providers[name];
        h += '<tr><td class="mono">' + esc(name) + (p.error ? ' <span class="bad small">(' + esc(p.error) + ')</span>' : '') + '</td>' +
          '<td class="mono small">' + (p.newSinceLast.map(esc).join(', ') || '—') + '</td>' +
          '<td class="mono small">' + (p.unconfigured.slice(0, 8).map(esc).join(', ') || '—') + (p.unconfigured.length > 8 ? ' …' : '') + '</td></tr>';
      });
      h += '</table></div>';
    }
  }
  document.getElementById('tab-config').innerHTML = h;
}

function renderPlatform() {
  var cf = DATA.cloudflare;
  var h = '';
  if (!cf) {
    h = '<div class="card"><p class="muted" style="margin:0">Not configured — set CLOUDFLARE_API_TOKEN (Account Analytics:Read) as a Worker secret to see Kompass\\u2019s own free-plan utilization.</p></div>';
  } else {
    var cpuBad = cf.workers.cpuTimeMsP99 >= cf.workers.cpuMsPerRequestLimit;
    h += '<h2 class="sec" style="margin-top:0">Cloudflare free-plan headroom <span class="muted small">(today, UTC)</span></h2>';
    h += '<div class="grid cards2">';
    h += '<div class="card"><h3>Workers</h3><table>';
    h += '<tr><td>requests</td><td>' + meter(cf.workers.requests, cf.workers.requestsLimit) + '</td></tr>';
    h += '<tr><td>CPU / request</td><td>p50 ' + cf.workers.cpuTimeMsP50 + 'ms · p99 <span class="' + (cpuBad ? 'bad' : '') + '">' + cf.workers.cpuTimeMsP99 + 'ms</span> <span class="muted small">(limit ' + cf.workers.cpuMsPerRequestLimit + 'ms)</span>' + (cpuBad ? ' <span class="bad small">⚠ hitting ceiling</span>' : '') + '</td></tr>';
    h += '<tr><td>errors / subreq</td><td>' + cf.workers.errors + ' · ' + fmt(cf.workers.subrequests) + '</td></tr></table></div>';
    h += '<div class="card"><h3>Durable Object</h3><table>';
    h += '<tr><td>requests</td><td>' + fmt(cf.durableObjects.requests) + ' <span class="muted small">(' + cf.durableObjects.errors + ' errors)</span></td></tr>';
    h += '<tr><td>wall time</td><td>' + (cf.durableObjects.wallTimeMsTotal / 1000).toFixed(1) + 's cumulative</td></tr></table></div>';
    h += '<div class="card"><h3>KV</h3><table>';
    h += '<tr><td>reads</td><td>' + meter(cf.kv.reads, cf.kv.readsLimit) + '</td></tr>';
    h += '<tr><td>writes</td><td>' + meter(cf.kv.writes, cf.kv.writesLimit) + '</td></tr>';
    h += '<tr><td>storage</td><td>' + fmtBytes(cf.kv.storageBytes) + ' / ' + fmtBytes(cf.kv.storageLimit) + '</td></tr></table></div>';
    h += '</div>';
  }
  document.getElementById('tab-platform').innerHTML = h;
}

function renderAll() {
  renderOverview(); renderAnalytics(); renderModels(); renderRoutes(); renderConfig(); renderPlatform();
}

/* ---- tabs ---- */
document.getElementById('tabs').addEventListener('click', function (e) {
  var b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.remove('active'); });
  document.querySelectorAll('section.tab').forEach(function (x) { x.classList.remove('active'); });
  b.classList.add('active');
  document.getElementById('tab-' + b.getAttribute('data-tab')).classList.add('active');
  localStorage.setItem('kompass_tab', b.getAttribute('data-tab'));
});

async function refresh() {
  var token = localStorage.getItem('kompass_bearer');
  if (!token) return;
  try {
    var res = await fetch('/status', { headers: { 'x-api-key': token } });
    if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 401 ? ' — bad token' : ''));
    DATA = await res.json();
    var disc = await fetch('/discovery', { headers: { 'x-api-key': token } });
    DISC = disc.ok ? await disc.json() : null;
    document.getElementById('login').style.display = 'none';
    document.getElementById('main').style.display = '';
    document.getElementById('tabs').style.display = '';
    document.getElementById('err').textContent = '';
    document.getElementById('dot').classList.remove('err');
    document.getElementById('upd').textContent = 'updated ' + new Date().toLocaleTimeString([], { hour12: false });
    var saved = localStorage.getItem('kompass_tab');
    if (saved && !document.querySelector('#tabs button.active[data-tab="' + saved + '"]')) {
      var btn = document.querySelector('#tabs button[data-tab="' + saved + '"]');
      if (btn) btn.click();
    }
    renderAll();
  } catch (e) {
    document.getElementById('err').textContent = String(e);
    document.getElementById('dot').classList.add('err');
    document.getElementById('upd').textContent = 'disconnected';
    if (String(e).indexOf('401') >= 0) {
      localStorage.removeItem('kompass_bearer');
      document.getElementById('login').style.display = '';
      document.getElementById('main').style.display = 'none';
      document.getElementById('tabs').style.display = 'none';
    }
  }
}
refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
