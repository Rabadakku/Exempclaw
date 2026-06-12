/**
 * The dashboard UI: a single self-contained HTML document, no build step.
 *
 * Design: "the succession ledger" — a personnel-dossier / ledger aesthetic
 * for software whose whole job is stepping into someone's vacated role.
 * Ink-black paper, amber phosphor, ruled lines, stamped disclosure modes,
 * tabular monospace figures. Fraunces for display, IBM Plex Mono for data.
 */
export function dashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Exempclaw — Succession Ledger</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>
  :root {
    --paper: #14120f;
    --paper-raise: #1b1814;
    --paper-card: #181511;
    --ink: #eae3d2;
    --ink-dim: #9a917d;
    --ink-faint: #6b6353;
    --rule: #2e2a22;
    --rule-soft: #242019;
    --amber: #f0a72e;
    --amber-soft: rgba(240, 167, 46, .14);
    --red: #d64a3a;
    --red-soft: rgba(214, 74, 58, .12);
    --green: #8aab6a;
    --serif: "Fraunces", Georgia, "Times New Roman", serif;
    --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; margin: 0; }
  html { color-scheme: dark; }
  body {
    background: var(--paper);
    color: var(--ink);
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.5;
    min-height: 100vh;
  }
  /* paper grain + vignette */
  body::before {
    content: "";
    position: fixed; inset: 0;
    background:
      radial-gradient(120% 90% at 50% 0%, transparent 55%, rgba(0,0,0,.5) 100%),
      repeating-linear-gradient(0deg, rgba(255,255,255,.014) 0 1px, transparent 1px 3px);
    pointer-events: none;
    z-index: 2;
  }
  ::selection { background: var(--amber); color: #181203; }

  header {
    display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
    padding: 28px 32px 18px;
    border-bottom: 1px solid var(--rule);
    position: relative;
  }
  header::after {
    content: "";
    position: absolute; left: 32px; right: 32px; bottom: -4px;
    border-bottom: 1px solid var(--rule-soft);
  }
  .masthead .kicker {
    font-size: 10px; letter-spacing: .42em; text-transform: uppercase; color: var(--amber);
  }
  .masthead h1 {
    font-family: var(--serif);
    font-weight: 650;
    font-size: 42px;
    letter-spacing: .01em;
    line-height: 1.04;
    margin-top: 2px;
  }
  .masthead h1 em { font-style: italic; font-weight: 420; color: var(--ink-dim); }
  .meta {
    text-align: right; color: var(--ink-dim); font-size: 11px; line-height: 1.7;
  }
  .meta .live { color: var(--ink); }
  .pulse {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    background: var(--amber); margin-right: 6px; vertical-align: 1px;
    box-shadow: 0 0 0 0 rgba(240,167,46,.6);
  }
  .pulse.tick { animation: pulse 1s ease-out; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(240,167,46,.65); } 100% { box-shadow: 0 0 0 12px rgba(240,167,46,0); } }

  main {
    display: grid; grid-template-columns: 330px 1fr; gap: 0;
    min-height: calc(100vh - 110px);
  }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }

  /* ── roster ─────────────────────────────── */
  #roster {
    border-right: 1px solid var(--rule);
    padding: 22px 18px 40px 32px;
  }
  .roster-label, .section-label {
    font-size: 10px; letter-spacing: .34em; text-transform: uppercase; color: var(--ink-faint);
    margin-bottom: 14px;
  }
  .dossier {
    position: relative;
    background: var(--paper-card);
    border: 1px solid var(--rule);
    border-left: 3px solid var(--rule);
    padding: 14px 14px 12px;
    margin-bottom: 12px;
    cursor: pointer;
    opacity: 0;
    transform: translateY(14px) rotate(-.4deg);
    animation: rise .5s cubic-bezier(.2,.7,.25,1) forwards;
    transition: border-color .2s, background .2s, transform .2s;
  }
  .dossier:hover { transform: translateY(-2px); border-left-color: var(--ink-dim); }
  .dossier.selected { border-left-color: var(--amber); background: var(--paper-raise); }
  @keyframes rise { to { opacity: 1; transform: translateY(0) rotate(0); } }
  .dossier .file-no {
    font-size: 10px; color: var(--ink-faint); letter-spacing: .18em; text-transform: uppercase;
    display: flex; justify-content: space-between;
  }
  .dossier .name {
    font-family: var(--serif); font-size: 22px; font-weight: 560; margin-top: 4px; line-height: 1.15;
  }
  .dossier .role { color: var(--ink-dim); font-size: 12px; }
  .dossier .succession {
    margin-top: 8px; font-size: 11px; color: var(--ink-dim);
    display: flex; align-items: baseline; gap: 6px;
  }
  .dossier .succession .leader { flex: 1; border-bottom: 1px dotted var(--ink-faint); transform: translateY(-3px); }
  .dossier .statline {
    display: flex; gap: 14px; margin-top: 10px; padding-top: 9px;
    border-top: 1px solid var(--rule-soft);
    font-size: 11px; color: var(--ink-dim);
    font-variant-numeric: tabular-nums;
  }
  .dossier .statline b { color: var(--ink); font-weight: 500; }

  .stamp {
    position: absolute; top: 12px; right: 12px;
    font-size: 9px; letter-spacing: .22em; text-transform: uppercase;
    border: 1.5px solid var(--amber); color: var(--amber);
    border-radius: 2px;
    padding: 2px 7px 1px;
    transform: rotate(3.2deg);
    opacity: .85;
  }
  .stamp.opaque { border-color: var(--red); color: var(--red); }

  /* ── detail ─────────────────────────────── */
  #detail { padding: 22px 32px 60px 28px; min-width: 0; }
  .detail-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .detail-head h2 { font-family: var(--serif); font-size: 30px; font-weight: 600; }
  .detail-head h2 span { color: var(--ink-dim); font-weight: 400; font-style: italic; }
  .detail-head .model { color: var(--ink-faint); font-size: 11px; letter-spacing: .08em; }

  .stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    border: 1px solid var(--rule); margin: 18px 0 26px;
    background: var(--paper-card);
  }
  .stat { padding: 12px 14px; border-right: 1px solid var(--rule-soft); }
  .stat:last-child { border-right: 0; }
  .stat .v {
    font-size: 21px; font-weight: 600; font-variant-numeric: tabular-nums;
    color: var(--ink); letter-spacing: -.01em;
  }
  .stat .v.amber { color: var(--amber); }
  .stat .v.red { color: var(--red); }
  .stat .k { font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: var(--ink-faint); margin-top: 2px; }

  table.ledger { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.ledger th {
    text-align: left; font-weight: 500; font-size: 10px; letter-spacing: .2em; text-transform: uppercase;
    color: var(--ink-faint); padding: 6px 10px 6px 0; border-bottom: 1px solid var(--rule);
  }
  table.ledger td {
    padding: 8px 10px 8px 0; border-bottom: 1px solid var(--rule-soft);
    vertical-align: top; font-variant-numeric: tabular-nums; color: var(--ink-dim);
  }
  table.ledger td.t { color: var(--ink); white-space: nowrap; }
  table.ledger tr:hover td { background: rgba(240,167,46,.03); }
  .chip {
    display: inline-block; font-size: 10px; letter-spacing: .06em;
    border: 1px solid var(--rule); border-radius: 2px; padding: 1px 6px; margin: 1px 4px 1px 0;
    color: var(--ink-dim);
  }
  .chip.ok { border-color: rgba(138,171,106,.5); color: var(--green); }
  .chip.deny { border-color: rgba(214,74,58,.55); color: var(--red); }
  .err { color: var(--red); font-size: 11px; }

  .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; margin-top: 30px; }
  @media (max-width: 1200px) { .columns { grid-template-columns: 1fr; } }

  .memo {
    border: 1px solid var(--rule); background: var(--paper-card);
    padding: 10px 12px; margin-bottom: 10px; font-size: 12px;
  }
  .memo .src {
    font-size: 10px; letter-spacing: .18em; text-transform: uppercase; color: var(--amber);
    display: flex; gap: 8px; align-items: baseline;
  }
  .memo .src .leader { flex: 1; border-bottom: 1px dotted var(--rule); transform: translateY(-3px); }
  .memo .src time { color: var(--ink-faint); letter-spacing: 0; text-transform: none; }
  .memo p { margin-top: 5px; color: var(--ink); }
  .memo .tags { margin-top: 5px; }

  .empty {
    margin: 12vh auto 0; max-width: 460px; text-align: center;
    border: 1.5px solid var(--rule); padding: 38px 30px;
    transform: rotate(-.6deg);
  }
  .empty .stamp-big {
    display: inline-block; border: 2px solid var(--amber); color: var(--amber);
    letter-spacing: .3em; text-transform: uppercase; font-size: 11px;
    padding: 5px 14px 4px; transform: rotate(-3deg); margin-bottom: 18px;
  }
  .empty p { color: var(--ink-dim); }
  .empty code { color: var(--amber); }

  a { color: var(--amber); }
  .footer-note { margin-top: 40px; color: var(--ink-faint); font-size: 10px; letter-spacing: .12em; }
</style>
</head>
<body>
<header>
  <div class="masthead">
    <div class="kicker">Exempclaw · Fleet Console</div>
    <h1>Succession <em>Ledger</em></h1>
  </div>
  <div class="meta">
    <div class="live"><span class="pulse" id="pulse"></span><span id="updated">connecting…</span></div>
    <div id="datadir"></div>
    <div>read-only · 127.0.0.1</div>
  </div>
</header>
<main>
  <nav id="roster"></nav>
  <section id="detail"></section>
</main>
<script>
(function () {
  'use strict';
  var state = { fleet: null, selected: null };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(value) {
    if (value == null) return 'n/a';
    return value > 0 && value < 0.01 ? '$' + value.toFixed(4) : '$' + value.toFixed(2);
  }
  function tokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    return String(n);
  }
  function when(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    var pad = function (x) { return String(x).padStart(2, '0'); };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function rosterCard(agent, index) {
    var persona = agent.persona || {};
    var name = persona.name || agent.id;
    var stampClass = persona.disclosure === 'opaque' ? 'stamp opaque' : 'stamp';
    var stamp = persona.disclosure ? '<span class="' + stampClass + '">' + esc(persona.disclosure.replace('_', ' ')) + '</span>' : '';
    var succession = persona.succeeds
      ? '<div class="succession"><span>succeeding</span><span class="leader"></span><span>' + esc(persona.succeeds) + '</span></div>'
      : '';
    return '<article class="dossier' + (state.selected === agent.id ? ' selected' : '') + '"' +
      ' style="animation-delay:' + (index * 70) + 'ms" data-id="' + esc(agent.id) + '">' +
      stamp +
      '<div class="file-no"><span>File № ' + esc(agent.id) + '</span></div>' +
      '<div class="name">' + esc(name) + '</div>' +
      '<div class="role">' + esc(persona.role || 'unregistered role') + '</div>' +
      succession +
      '<div class="statline">' +
        '<span><b>' + agent.runs.total + '</b> runs</span>' +
        '<span><b>' + agent.memoryCount + '</b> memories</span>' +
        '<span><b>' + money(agent.costUsd) + '</b></span>' +
      '</div>' +
    '</article>';
  }

  function outwardChips(actions) {
    if (!actions.length) return '';
    return actions.map(function (a) {
      var cls = a.approved ? 'chip ok' : 'chip deny';
      var mark = a.approved ? '✓ ' : '✗ ';
      return '<span class="' + cls + '" title="' + esc(a.summary) + '">' + mark + esc(a.tool) + '</span>';
    }).join('');
  }

  function detailView(agent) {
    var persona = agent.persona || {};
    var name = persona.name || agent.id;
    var roleBits = [persona.role, persona.succeeds ? 'succeeding ' + persona.succeeds : null]
      .filter(Boolean).map(esc).join(' · ');

    var rows = agent.runs.recent.map(function (r) {
      return '<tr>' +
        '<td class="t">' + when(r.startedAt) + '</td>' +
        '<td>' + esc(r.trigger) + '</td>' +
        '<td>' + r.iterations + '</td>' +
        '<td>' + tokens(r.tokens) + '</td>' +
        '<td>' + money(r.costUsd) + '</td>' +
        '<td>' + (r.error ? '<span class="err">' + esc(r.error) + '</span>' : esc(r.stopReason || '—')) +
          (r.outward.length ? '<br>' + outwardChips(r.outward) : '') + '</td>' +
      '</tr>';
    }).join('');

    var memories = agent.recentMemories.map(function (m) {
      var tags = m.tags.map(function (t) { return '<span class="chip">#' + esc(t) + '</span>'; }).join('');
      return '<div class="memo">' +
        '<div class="src"><span>' + esc(m.source) + '</span><span class="leader"></span><time>' + when(m.createdAt) + '</time></div>' +
        '<p>' + esc(m.text) + '</p>' +
        (tags ? '<div class="tags">' + tags + '</div>' : '') +
      '</div>';
    }).join('');

    var deniedClass = agent.outward.denied > 0 ? 'v red' : 'v';
    return '' +
      '<div class="detail-head">' +
        '<h2>' + esc(name) + (roleBits ? ' <span>— ' + roleBits + '</span>' : '') + '</h2>' +
        '<div class="model">' + esc(agent.model || '') + '</div>' +
      '</div>' +
      '<div class="stats">' +
        '<div class="stat"><div class="v">' + agent.runs.total + '</div><div class="k">runs</div></div>' +
        '<div class="stat"><div class="v">' + tokens(agent.usage.inputTokens + agent.usage.cacheReadTokens + agent.usage.cacheWriteTokens) + '</div><div class="k">tokens in</div></div>' +
        '<div class="stat"><div class="v">' + tokens(agent.usage.outputTokens) + '</div><div class="k">tokens out</div></div>' +
        '<div class="stat"><div class="v">' + tokens(agent.usage.cacheReadTokens) + '</div><div class="k">cache reads</div></div>' +
        '<div class="stat"><div class="v">' + agent.outward.total + '</div><div class="k">outward acts</div></div>' +
        '<div class="stat"><div class="' + deniedClass + '">' + agent.outward.denied + '</div><div class="k">denied</div></div>' +
        '<div class="stat"><div class="v amber">' + money(agent.costUsd) + '</div><div class="k">est. spend</div></div>' +
      '</div>' +
      '<div class="section-label">Ledger of runs</div>' +
      (rows
        ? '<table class="ledger"><thead><tr><th>when</th><th>trigger</th><th>turns</th><th>tokens</th><th>cost</th><th>disposition</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<p style="color:var(--ink-dim)">No runs recorded yet.</p>') +
      '<div class="columns"><div>' +
        '<div class="section-label">Role memory — most recent</div>' +
        (memories || '<p style="color:var(--ink-dim)">Nothing on file. Run an ingest pass to seed it.</p>') +
      '</div><div>' +
        '<div class="section-label">Connectors</div>' +
        (agent.connectors.length
          ? agent.connectors.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join(' ')
          : '<p style="color:var(--ink-dim)">None wired.</p>') +
      '</div></div>' +
      '<div class="footer-note">Memories shown: ' + agent.recentMemories.length + ' of ' + agent.memoryCount +
      ' · runs shown: ' + agent.runs.recent.length + ' of ' + agent.runs.total + '</div>';
  }

  function emptyView() {
    return '<div class="empty">' +
      '<div class="stamp-big">No agents on file</div>' +
      '<p>This ledger fills itself from the data directory.</p>' +
      '<p style="margin-top:10px">Open the first dossier with<br><code>exempclaw run agents/your-agent.json "hello"</code></p>' +
    '</div>';
  }

  function render() {
    var roster = document.getElementById('roster');
    var detail = document.getElementById('detail');
    var fleet = state.fleet;
    if (!fleet || fleet.agents.length === 0) {
      roster.innerHTML = '<div class="roster-label">Fleet roster</div>';
      detail.innerHTML = emptyView();
      return;
    }
    if (!state.selected || !fleet.agents.some(function (a) { return a.id === state.selected; })) {
      state.selected = fleet.agents[0].id;
    }
    roster.innerHTML = '<div class="roster-label">Fleet roster — ' + fleet.agents.length + ' on file</div>' +
      fleet.agents.map(rosterCard).join('');
    var selected = fleet.agents.find(function (a) { return a.id === state.selected; });
    detail.innerHTML = detailView(selected);

    Array.prototype.forEach.call(roster.querySelectorAll('.dossier'), function (el) {
      el.addEventListener('click', function () {
        state.selected = el.getAttribute('data-id');
        render();
      });
    });
  }

  var firstLoad = true;
  function refresh() {
    fetch('/api/fleet').then(function (res) { return res.json(); }).then(function (fleet) {
      var changed = JSON.stringify(fleet.agents) !== JSON.stringify(state.fleet && state.fleet.agents);
      state.fleet = fleet;
      document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
      document.getElementById('datadir').textContent = fleet.dataDir;
      var pulse = document.getElementById('pulse');
      pulse.classList.remove('tick');
      void pulse.offsetWidth;
      pulse.classList.add('tick');
      if (changed || firstLoad) { render(); firstLoad = false; }
    }).catch(function () {
      document.getElementById('updated').textContent = 'connection lost — retrying';
    });
  }

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
}
