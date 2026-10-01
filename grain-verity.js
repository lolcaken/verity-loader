/* Grain Verity - standalone (no userscript, no extensions)
 *
 * Log into app.educationperfect.com, then load it ONE of these ways -
 *   1) bookmarklet, from the install page:
 *      javascript:(function(){fetch('RAW_URL').then(function(r){return r.text()})
 *        .then(function(t){(0,eval)(t)})})()
 *   2) Tampermonkey loader:
 *      https://raw.githubusercontent.com/lolcaken/verity-loader/main/verity-loader.user.js
 *
 * A <script src> tag will NOT work here: the site CSP does not allow
 * raw.githubusercontent.com in script-src, so it has to be fetched and
 * eval'd instead.
 *
 * If the panel does not appear, the kill switch is off:
 *   https://api.github.com/repos/lolcaken/verity-cfg/contents/verity-gate.txt
 * must read "yes".
 *
 * Everything below is the script itself. No @match, no @grant, no userscript header.
 */

(() => {
  'use strict';

  /* ── KILL SWITCH ──────────────────────────────────────────────────────
     Before touching EP, this asks your endpoint whether to run.
     Flip the hosted file's contents to anything other than "yes" to revoke
     every copy on its next page load. Fail-closed by default: if your
     endpoint is unreachable, the tool does not run.
     NOTE: this is a speed bump, not security. Anyone who reads this file
     can extract the URL and answer it themselves.                              */
  const VT_GATE_KEY = 'yes';
  const VT_GATE_TIMEOUT = 4000;
  const VT_FAIL_OPEN = false;
  /* No localStorage authorisation cache. The old one let a single console line
     grant a pass forever:
       localStorage.setItem('vtGateCache','{"v":"yes","t":'+Date.now()+'}')
     which made the gate - and any denylist behind it - advisory only.
     (vtGate itself now lives down in the unified-config block, reading
     config.json.) */
  /* ── END KILL SWITCH ───────────────────────────────────────────────── */

    /* ── START LOG (discord embeds) ───────────────────────────────────────── */
  const VT_HOOK_CFG = ['aHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy9sb2xjYWtlbi9lcC1jZmcvY29udGVudHMvaG9vay50', 'eHQ='];
  const VT_DENY_REPEAT = 'your banned LOSER';
  const VT_DENY_ALERT_EVERY = 5000;
  const VT_DENY_SPIN_MS = 1200;
  /* full-screen images, shown for 2s on the same beat as the alert. Plain <img>
     src rather than fetch+blob: pinterest (and most image hosts) do not send
     permissive CORS, so a blob: round-trip fails, while a plain img element
     loads fine. */

  const VT_VERSION = '2.6.4';
  const VT_LOG_ON = true;
  const VT_HOOK_CACHE = 'vtHookUrl';
  const VT_HOOK_TTL = 604800000;   // 7 days: the webhook url changes about never
  const VT_GOLD = 0xe0b64a, VT_GREEN = 0x7ac07a, VT_RED = 0xe06c6c, VT_GREY = 0x4d4d4d;
  const VT_LOG = { id: null, type: "", classes: [], errors: [], started: 0, runLists: 0, runMods: 0, maxRate: 0, done: false, announced: false, why: [], notes: [] };
  /* Record WHY something is missing rather than letting a card say "unknown".
     A card built before identity resolves is the case that hurts most, so the
     outbox expands these at delivery time, not when the card is queued. */
  function vtWhy(s) { if (s && VT_LOG.why.indexOf(s) < 0 && VT_LOG.why.length < 6) VT_LOG.why.push(String(s).slice(0, 60)); }
  function vtNote(s) { if (s && VT_LOG.notes.indexOf(s) < 0 && VT_LOG.notes.length < 4) VT_LOG.notes.push(String(s).slice(0, 120)); }
  const VT_MIN_GAP = 450;

  function vtHookUrl() {
    try {
      const c = JSON.parse(localStorage.getItem(VT_HOOK_CACHE) || 'null');
      if (c && c.u && Date.now() - c.t < VT_HOOK_TTL) return Promise.resolve(c.u);
    } catch (e) { /* ignore */ }
    return fetch(atob(VT_HOOK_CFG.join('')), { credentials: 'omit', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.content) return null;
        const u = atob(String(j.content).replace(/\s+/g, '')).trim();
        if (!u) return null;
        try { localStorage.setItem(VT_HOOK_CACHE, JSON.stringify({ u: u, t: Date.now() })); } catch (e) { /* ignore */ }
        return u;
      })
      .catch(function () { return null; });
  }

  /* ── DURABLE OUTBOX ────────────────────────────────────────────────────
     A school or cafe network can block Discord, in which case fetch rejects
     with a TypeError and there is no response to inspect. The old path was
     fire-and-forget, so those cards were silently dropped forever.

     Now a card is written to localStorage *before* delivery is attempted, and
     only removed once Discord has actually accepted it. Anything undelivered
     is retried on the next page load, so cards queue up while offline and
     arrive in order later. This makes logging reliable; it does not make it
     hidden - anyone with devtools can still strip it from their own copy. */
  const VT_OUTBOX_KEY = 'vtOutbox';
  const VT_OUTBOX_MAX = 60;
  let vtBlocked = false;
  function vtOutboxRead() {
    try {
      const r = JSON.parse(localStorage.getItem(VT_OUTBOX_KEY) || '[]');
      return Array.isArray(r) ? r : [];
    } catch (e) { return []; }
  }
  function vtOutboxWrite(list) {
    try { localStorage.setItem(VT_OUTBOX_KEY, JSON.stringify(list.slice(-VT_OUTBOX_MAX))); } catch (e) { /* ignore */ }
  }
  /* A queued card stores only WHAT happened, not the rendered embed. The embed
     is built here, at delivery time, so a card that sat in the outbox while
     identity was still resolving carries the full identity once it finally
     sends. Building it at enqueue time was losing exactly the data you need
     when a run went wrong. */
  function vtExpand(item) {
    if (!item || !item.k) return item;
    const extra = (item.extra || []).slice();
    if (item.result) extra.unshift({ name: 'Result', value: item.result, inline: true });
    if (item.reason) extra.push({ name: 'Reason on file', value: vtCut(item.reason, 200), inline: false });
    if (VT_LOG.notes.length) extra.push({ name: 'Notes', value: vtCut(VT_LOG.notes.join(' · '), 400), inline: false });
    let fields = vtWhoField((item.pre || []).concat(extra)).concat(vtEnvFields(), vtClassField());
    if (item.k === 'run') {
      fields = fields.concat(vtModField(8));
      if (VT_LOG.errors.length) fields.push({ name: 'Errors (' + VT_LOG.errors.length + ')', value: vtCut(VT_LOG.errors.slice(0, 3).join('\n'), 1000), inline: false });
    }
    return {
      embeds: [{
        title: item.title,
        color: item.color,
        fields: fields,
        footer: { text: 'verity ' + VT_VERSION + ' · ' + new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC' },
        timestamp: new Date().toISOString()
      }]
    };
  }
  /* true when the card was accepted; false means keep it and try again later */
  function vtDeliver(item) {
    return vtHookUrl().then(function (u) {
      if (!u) return false;
      let payload;
      try { payload = vtExpand(item); } catch (e) { payload = item; }
      return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { return !!(r && r.ok); })
        .catch(function () { return false; });
    }).catch(function () { return false; });
  }
  function vtSend(item) {
    /* persist first: if the network dies between here and the POST, the card
       is still on disk for the next load */
    const box = vtOutboxRead();
    box.push(item);
    vtOutboxWrite(box);
    vtPump();
  }
  let vtPumping = false, vtLastPost = 0;
  function vtPump() {
    if (vtPumping) return;
    const box = vtOutboxRead();
    if (!box.length) { vtBlocked = false; return; }
    const now = Date.now();
    if (now - vtLastPost < VT_MIN_GAP) { setTimeout(vtPump, VT_MIN_GAP - (now - vtLastPost)); return; }
    const payload = box[0];
    vtPumping = true; vtLastPost = now;
    vtDeliver(payload).then(function (ok) {
      vtPumping = false;
      if (ok) {
        vtOutboxWrite(vtOutboxRead().slice(1));
        vtBlocked = false;
      } else {
        /* blocked, not broken: stop hammering and wait for the next page load */
        vtBlocked = true;
        vtPaintLogState();
        return;
      }
      vtPaintLogState();
      vtPump();
    });
  }
  function vtOutboxPending() { return vtOutboxRead().length; }
  /* repaint the detail row after a delivery state change */
  function vtPaintLogState() {
    try { if (typeof renderStatus === 'function' && phase) renderStatus(); } catch (e) { /* ignore */ }
  }
  /* callers pass a descriptor: {k, title, color, extra, result, reason}.
     The embed itself is assembled in vtExpand at delivery time. */
  function vtEmbed(item) {
    if (!VT_LOG_ON || !item) return;
    vtSend(item);
  }

  const vtCut = (v, n) => { const t = String(v == null ? "-" : v); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  function vtWhoField(extra) {
    const bits = [{ name: 'Student', value: vtCut(ID.name || 'unknown', 80), inline: true }];
    if (ID.user) bits.push({ name: 'User ID', value: String(ID.user), inline: true });
    if (ID.uuid) bits.push({ name: 'UUID', value: vtCut(ID.uuid, 36), inline: true });
    if (ID.session) bits.push({ name: 'Session', value: vtCut(String(ID.session).slice(-8), 12), inline: true });
    if (ID.type) bits.push({ name: 'Role', value: vtCut(ID.type, 24), inline: true });
    bits.push({ name: 'School', value: String(ID.school || '-'), inline: true });
    /* why identity is thin, so a failed run is diagnosable instead of just
       saying "unknown" */
    if (VT_LOG.why.length) bits.push({ name: 'Identity', value: vtCut(VT_LOG.why.join(' · '), 200), inline: false });
    if (extra) { for (const f of extra) if (f) bits.push(f); }
    return bits;
  }
  function vtEnvFields() {
    const nav = (navigator && navigator.userAgent) ? navigator.userAgent : '';
    const plat = nav.match(/(Windows|Mac OS|Linux|Android|iPhone|iPad)/);
    const out = [];
    if (plat) out.push({ name: 'Platform', value: plat[1], inline: true });
    out.push({ name: 'Build', value: 'verity ' + VT_VERSION, inline: true });
    if (ID.org) out.push({ name: 'Org', value: vtCut(ID.org, 36), inline: true });
    return out;
  }
  function vtModField(limit) {
    if (!VT_LOG.mods || !VT_LOG.mods.length) return [];
    const rows = VT_LOG.mods.slice(-(limit || 6)).map(function (m) {
      return '• ' + m.id + (m.name ? ' ' + vtCut(m.name, 34) : '') + ' — ' + m.lists + ' lists' + (m.pts ? ', +' + m.pts + 'pt' : '') + (m.unsup ? ', ' + m.unsup + ' nocredit' : '') + (m.dry ? ', dry' : '');
    });
    return [{ name: 'Modules this run', value: vtCut(rows.join('\n'), 1000), inline: false }];
  }
  function vtClassField() {
    if (!VT_LOG.classes.length) return [];
    return [{ name: 'Classes', value: vtCut(VT_LOG.classes.map(function (c) { return '• ' + c; }).join('\n'), 1000), inline: false }];
  }

  function vtLogClasses(uuid) {
    if (!uuid) return Promise.resolve([]);
    const q = 'query Me($id: UUID!) { user(id: $id) { classes { name } } }';
    return fetch(GQL, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, variables: { id: uuid } })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        const c = j && j.data && j.data.user && j.data.user.classes;
        if (Array.isArray(c)) VT_LOG.classes = c.map(function (x) { return x.name; }).filter(Boolean).slice(0, 6);
        return VT_LOG.classes;
      })
      .catch(function () { return []; });
  }

  function vtErr(line) {
    if (!VT_LOG_ON || !line) return;
    if (VT_LOG.errors.indexOf(line) < 0) VT_LOG.errors.push(vtCut(line, 110));
  }

  /* returns the promise, so callers can order cards. The card is enqueued as a
     descriptor; vtExpand renders it at delivery time. */
  function vtLogCard(title, color, extraFields) {
    if (!VT_LOG_ON) return Promise.resolve();
    return fetch('https://authentication.educationperfect.com/me', { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j) {
          if (j.UserId) ID.uuid = j.UserId;
          if (j.UserType) ID.type = j.UserType;
          if (!ID.name) ID.name = ((j.FirstName || '') + ' ' + (j.LastName || '')).trim() || null;
          if (!ID.user) vtWhy('card built before identity resolved');
        } else {
          vtWhy('/me unavailable at card time');
        }
        return (VT_LOG.classes.length || !j || !j.UserId) ? [] : vtLogClasses(j.UserId);
      })
      .catch(function () { vtWhy('/me fetch threw at card time'); return []; })
      .then(function () {
        vtEmbed({ k: 'basic', title: title, color: color, extra: extraFields || [] });
      });
  }
  function vtLogLoaded() {
    if (!VT_LOG_ON || VT_LOG.saidLoad) return Promise.resolve();
    VT_LOG.saidLoad = true;
    return vtLogCard('Verity — page loaded', VT_GREY, [{ name: 'Selected modules', value: String(VT_LOG.picked || 0), inline: true }]);
  }
  function vtLogRun() {
    if (!VT_LOG_ON || VT_LOG.saidRun) return;
    VT_LOG.saidRun = true;
    vtLogCard(
      'Verity — run started',
      VT_GOLD,
      [{ name: 'Target score', value: VT_LOG.target ? String(VT_LOG.target) : 'no limit', inline: true },
       { name: 'Selected modules', value: String(VT_LOG.picked || 0), inline: true }]
    );
  }

  function vtLogDone(res) {
    if (!VT_LOG_ON || VT_LOG.done) return;
    VT_LOG.done = true;
    res = res || {};
    const secs = VT_LOG.started ? Math.round((Date.now() - VT_LOG.started) / 1000) : 0;
    const pts = res.pts || 0;
    const extra = [
      { name: 'Result', value: (pts > 0 ? '+' : '') + pts + ' pt', inline: true },
      { name: 'Duration', value: secs + 's', inline: true },
      { name: 'Rate', value: (VT_LOG.maxRate || 0) + ' Q/s', inline: true },
      { name: 'Lists this run', value: String(res.lists != null ? res.lists : VT_LOG.runLists), inline: true },
      { name: 'Modules', value: String(res.mods != null ? res.mods : VT_LOG.runMods), inline: true },
      { name: 'Lists done (total)', value: String(res.total != null ? res.total : '-'), inline: true }
    ];
    if (res.reason) extra.push({ name: 'Outcome', value: vtCut(res.reason, 200), inline: false });
    vtEmbed({
      k: 'run',
      title: res.ok === false ? 'Verity — run ended early' : 'Verity — run complete',
      color: res.ok === false ? VT_RED : (pts > 0 ? VT_GREEN : VT_GREY),
      result: (pts > 0 ? '+' : '') + pts + ' pt',
      reason: res.reason,
      pre: VT_LOG.startScore != null ? [{ name: 'Score before', value: String(VT_LOG.startScore), inline: true }] : []
    });
  }
  /* ── END START LOG ────────────────────────────────────────────────────── */

  /* ── DENYLIST ───────────────────────────────────────────────────────────
     The list is data and lives in lolcaken/verity-cfg, so a copy made today
     still picks up an edit tomorrow. That only holds for builds that already
     contain this code: a build from before it never fetches the file.
     Matched on ID.user or ID.uuid. `name` is a scaffold for before you know
     the id, and deliberately does not match here - two people can share a
     name, and a name that fails to match fails open.
     Any error returns "not denied": a bad fetch must never lock out a user
     who is not on the list.                                            */
  /* ── UNIFIED CONFIG (2.6.2) ───────────────────────────────────────────
     One fetch for everything. Before, a page load cost three requests to
     api.github.com (gate, denylist, hook). The unauthenticated limit is
     60/hr per IP and a school shares one NAT, so a handful of users running
     ~20 loads a day blew past it - and every failure looked like a revocation.
     config.json holds gate, deny[] and notice; the build splits it locally. */
  const VT_CFG_PARTS = ['aHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy9sb2xjYWtlbi92ZXJpdHktY2ZnL2NvbnRlbnRzL2NvbmZpZy5qc29u', ''];
  const VT_CFG_CACHE = 'vtCfg';
  const VT_CFG_TTL = 900000;          // 15 min; config is cheap to refetch
  let vtCfgData = null;               // last good parse, survives a bad fetch
  let vtCfgStale = 0;                 // epoch ms of last success
  let vtCfgFetching = false;

  function vtCfgRead() {
    /* Always hydrate from disk first. A stale cache beats no cache - that is
       the whole point - so the TTL decides only whether to REFETCH, never
       whether to USE what is already on disk. Getting this backwards meant a
       48-minute-old config was discarded and a rate-limited network looked
       exactly like a revocation. */
    try {
      const c = JSON.parse(localStorage.getItem(VT_CFG_CACHE) || 'null');
      if (c && c.d) {
        if (!vtCfgData) { vtCfgData = c.d; vtCfgStale = c.t || 0; }
        if (Date.now() - c.t < VT_CFG_TTL) return Promise.resolve(c.d);
      }
    } catch (e) { /* ignore */ }
    return vtCfgFetch();
  }
  function vtCfgFetch() {
    if (vtCfgFetching) return Promise.resolve(vtCfgData);
    let url;
    try { url = atob(VT_CFG_PARTS.join('')); } catch (e) { return Promise.resolve(vtCfgData); }
    vtCfgFetching = true;
    return fetch(url, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) {
        /* 403/429 is GitHub rate-limiting, not a revoked user. Keep the last
           good config and carry on. 404 means the file is gone, which is a
           real problem and should fall through to fail-closed below. */
        if (r.status === 403 || r.status === 429) { vtCfgFetching = false; return vtCfgData; }
        if (!r.ok) { vtCfgFetching = false; return Promise.reject(new Error('http ' + r.status)); }
        return r.json();
      })
      .then(function (j) {
        vtCfgFetching = false;
        if (!j || !j.content) return vtCfgData;
        const raw = atob(String(j.content).replace(/\s+/g, ''));
        const d = JSON.parse(raw);
        if (!d || typeof d !== 'object') return vtCfgData;
        vtCfgData = d; vtCfgStale = Date.now();
        try { localStorage.setItem(VT_CFG_CACHE, JSON.stringify({ d: d, t: vtCfgStale })); } catch (e) { /* ignore */ }
        return d;
      })
      .catch(function () { vtCfgFetching = false; return vtCfgData; });
  }
  function vtCfgAge() { return vtCfgStale ? Math.round((Date.now() - vtCfgStale) / 60000) : null; }
  function vtCfgStaleLabel() {
    const age = vtCfgAge();
    if (age === null) return '';
    return age < 20 ? '' : 'config: stale (' + (age < 60 ? age + 'm' : Math.round(age / 60) + 'h') + ')';
  }

  /* ── UPDATE NOTICE ──────────────────────────────────────────────────────
     A one-line "UPDATED!!" corner notice when config.json's "ver" names a
     version newer than the running build.

     Read out of the config the gate already fetched, not a second request.
     The unauth GitHub limit is 60/hr per IP, which is the whole reason gate,
     denylist and notice were folded into one file in 2.6.2 - a request per
     page load just to ask a version question would undo that. The cost of
     sharing is that the notice is only as fresh as the config cache, up to
     VT_CFG_TTL old, and that a config that fails to load also silences it.
     Both are the right trade for something that must not break the tool it
     is attached to.

     By the time this runs the config is already resolved - vtBoot awaits
     vtCfgRead before the gate, and the panel only mounts after that - so this
     is synchronous and cannot delay or fail boot. Three ways it no-ops, all
     deliberate: the marker is set, "ver" is absent or unparseable, or the
     remote is not newer. */
  const VT_UPD_SEEN = 'vtUpdSeen';    // '1' once shown. ONE WAY DOOR: there is
                                      // no version key in it, so the first
                                      // account to see a notice never sees
                                      // another. Renaming this constant is the
                                      // only way back, and the old key is left
                                      // unread so nobody re-nags on upgrade.
  const VT_UPD_MS = 15000;            // on screen this long, then it leaves
  const VT_UPD_OUT_MS = 320;          // must match the vt-upd-out transition
  let vtUpdStarted = false;
  let vtUpdTimer = null;

  /* numeric semver, not a string compare: '2.10.0' > '2.9.0' and
     '2.6.10' > '2.6.3' both have to hold, and lexicographically they don't. */
  function vtVerParse(s) {
    const m = /^\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(s == null ? '' : String(s));
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  function vtVerNewer(remote, local) {
    const r = vtVerParse(remote), l = vtVerParse(local);
    if (!r || !l) return false;
    for (let i = 0; i < 3; i++) if (r[i] !== l[i]) return r[i] > l[i];
    return false;
  }
  /* null for anything that is not a plain string, so a number or an object
     dropped into the file by hand is ignored rather than coerced */
  function vtVerFromCfg(cfg) {
    return cfg && typeof cfg.ver === 'string' ? cfg.ver : null;
  }
  /* the marker gates the WORK, and with the version riding on config.json
     that now also means it gates the notice before anything reads it */
  function vtUpdSeen() { try { return !!localStorage.getItem(VT_UPD_SEEN); } catch (e) { return false; } }
  function vtUpdMark() { try { localStorage.setItem(VT_UPD_SEEN, '1'); } catch (e) { /* ignore */ } }
  function vtUpdShow(from, to) {
    const el = document.getElementById('az-upd');
    if (!el) return false;
    const o = document.getElementById('az-upd-o'), n = document.getElementById('az-upd-n');
    /* textContent, never innerHTML: config.json is remote input and a hostile
       "ver" must not be able to put markup in the page */
    if (o) o.textContent = from;
    if (n) n.textContent = to;
    el.classList.remove('is-out');
    el.classList.add('is-on');
    vtUpdArmClose();
    return true;
  }
  /* Fades UP and off the top of the screen. The class is left on the element
     until the transition is over, then both classes come off together, so a
     second show can never land on a half-closed notice. */
  function vtUpdHide() {
    const el = document.getElementById('az-upd');
    if (!el) return false;
    if (vtUpdTimer) { clearTimeout(vtUpdTimer); vtUpdTimer = null; }
    el.classList.add('is-out');
    setTimeout(function () {
      el.classList.remove('is-on');
      el.classList.remove('is-out');
    }, VT_UPD_OUT_MS);
    return true;
  }
  function vtUpdArmClose() {
    if (vtUpdTimer) clearTimeout(vtUpdTimer);
    vtUpdTimer = setTimeout(function () { vtUpdTimer = null; vtUpdHide(); }, VT_UPD_MS);
  }
  /* synchronous, and it never throws: the config is already resolved by the
     time the panel mounts, so there is nothing to wait for and nothing that
     can reject into an unhandled rejection */
  function vtUpdCheck() {
    if (vtUpdStarted) return false;
    if (vtUpdSeen()) return false;
    vtUpdStarted = true;
    let remote = null;
    try { remote = vtVerFromCfg(vtCfgData); } catch (e) { return false; }
    if (!remote || !vtVerNewer(remote, VT_VERSION)) return false;
    vtUpdMark();                 // written BEFORE the render, so a throw in
    return vtUpdShow(VT_VERSION, remote);   // the render can never re-notify
  }
  /* Console hook for looking at the notice before shipping it:
        __azMoney.upd()        -> shows it aimed at 9.9.9
        __azMoney.upd('2.7.0') -> shows it aimed at 2.7.0
     It renders the real notice with a version you choose and does NOT write
     the marker, so the one-shot notice stays unspent and cannot be faked
     into firing for real. It bypasses the compare entirely, which is the
     point: on an up-to-date build there is otherwise no way to preview it,
     and burning the marker to look at it would cost the only copy you get.
     Closes on the x or after VT_UPD_MS, same as the real one. */
  function vtUpdPreview(to) {
    const v = String(to == null ? '9.9.9' : to).slice(0, 40);
    return vtUpdShow(VT_VERSION, v);
  }

  function vtGate(cfg) {
    if (cfg && typeof cfg.gate === 'string') return Promise.resolve(cfg.gate.trim().toLowerCase() === VT_GATE_KEY);
    if (cfg === vtCfgData && vtCfgData) return Promise.resolve(String(vtCfgData.gate || '').trim().toLowerCase() === VT_GATE_KEY);
    return vtCfgRead().then(function (c) {
      if (!c) return false;                          // never seen: fail closed
      return String(c.gate || '').trim().toLowerCase() === VT_GATE_KEY;
    });
  }
  /* Returns the matching entry, or null. `cfg` is the already-fetched file so
     the caller only makes one request. */
  function vtDeniedFrom(cfg) {
    return Promise.resolve().then(function () {
      if (!cfg || !Array.isArray(cfg.deny)) return null;
      if (!ID.user && !ID.uuid) return null;
      const uid = Number(ID.user), uuid = ID.uuid || null;
      for (const e of cfg.deny) {
        if (!e || typeof e !== 'object') continue;
        const eid = Number(e.id);
        if (Number.isFinite(eid) && eid > 0 && eid === uid) return e;
        if (e.uuid && uuid && String(e.uuid).toLowerCase() === String(uuid).toLowerCase()) return e;
      }
      return null;
    });
  }
  function vtDenied() { return vtCfgRead().then(vtDeniedFrom); }
  function vtDenyNotice(cfg) {
    if (cfg && typeof cfg.notice === 'string' && cfg.notice.trim()) return cfg.notice;
    return 'you are not authorised to use this script, contact the owner of ts if you think this is a mistake';
  }
  function vtLogDenied(why) {
    if (!VT_LOG_ON || VT_LOG.saidDeny) return;
    VT_LOG.saidDeny = true;
    vtEmbed({
      k: 'denied',
      title: 'Verity — access denied',
      color: VT_RED,
      result: 'denied',
      reason: why || 'not recorded'
    });
  }
  /* Local only: the alert, the image and the page distortion never leave the
     browser and a refresh undoes all of it. */
  function vtPunish(notice) {
    try { window.alert(notice); } catch (e) { /* ignore */ }
    /* repeat so dismissing it is not the end of it. Modal, so it needs one
       click per cycle - annoying, never blocking, refresh still clears it.
       The image shows after each dismissal, so the two never overlap. */
    try {
      setInterval(function () {
        try { window.alert(VT_DENY_REPEAT); } catch (e) { /* ignore */ }
      }, VT_DENY_ALERT_EVERY);
    } catch (e) { /* ignore */ }
    try {
      const st = document.createElement('style');
      st.id = 'vt-deny-style';
      st.textContent = 'html{filter:invert(1) hue-rotate(180deg)!important;animation:vt-spin ' + VT_DENY_SPIN_MS + 'ms linear infinite!important;}'
        + '@keyframes vt-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) { /* ignore */ }
    const hue = [0, 60, 120, 180, 240, 300];
    let i = 0;
    const paint = () => {
      try {
        document.documentElement.style.backgroundColor = 'hsl(' + hue[i++ % hue.length] + ',85%,45%)';
      } catch (e) { /* ignore */ }
    };
    paint();
    setInterval(paint, 700);
    try {
      const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, null);
      const kill = [];
      let n;
      while ((n = w.nextNode())) {
        if (n.nodeValue && n.nodeValue.trim()) kill.push(n);
      }
      for (const t of kill) { try { t.nodeValue = 'your banned. HAhA'; } catch (e) { /* ignore */ } }
    } catch (e) { /* ignore */ }
  }


  if (window.__azMoney) { window.__azMoney.rerun(); return; }

  const API = 'https://services.educationperfect.com';
  const GQL = 'https://graphql-gateway.educationperfect.com/graphql/';
  const NS = 'nz.co.LanguagePerfect.Services.PortalsAsync.App.AppServicesPortal.';

  const ID = { user: null, uuid: null, school: null, class: null, session: null, us: null, org: null, sub: 6, targ: 30, type: 'unknown', name: null };
  const FALLBACK_US = [3961339925188856, 412505154051378, 3743432216006458, 3980863574917874, 6133];
  const MODULES = [8474068, 8474073, 8474061, 8496192, 8474025];
  const SUBS = [[1, 'French'], [2, 'Japanese'], [3, 'German'], [4, 'Spanish'], [7, 'ESOL'], [9, 'Indonesian'], [11, 'Chinese'], [14, 'Russian'], [24, 'Arabic'], [30, 'Mathematics'], [31, 'Geography'], [32, 'Science'], [38, 'History'], [39, 'Accounting'], [40, 'Economics'], [45, 'Music'], [46, 'Digital Technologies'], [55, 'Physical Education'], [62, 'English & Literature'], [63, 'General Knowledge'], [65, 'Health & PE'], [66, 'Malay'], [67, 'Thai'], [101, 'Cross-curricular']];
  const SUB_OF = Object.fromEntries(SUBS);
  async function discoverModules() {
    const found = new Map();
    for (const [sub] of SUBS) {
      const j = await A(NS + 'GetModulesForContentBrowserWithSchoolId', [{ TargetSubjectId: sub, BaseLanguageId: 6 }, ID.school], 15000);
      const mods = j && j.result && j.result.Modules;
      if (Array.isArray(mods)) for (const m of mods) if (m && m.ModuleId) found.set(m.ModuleId, { id: m.ModuleId, name: (m.Name || ('module ' + m.ModuleId)).replace(/\|.*/, '').trim(), subject: SUB_OF[sub] || String(sub), official: !!m.IsOfficial, personal: !!m.IsPersonal, highlighted: !!m.IsHighlighted });
    }
    return [...found.values()];
  }
  const CFG = { NewData: 33, workers: 20, prefetch: 20, spacing: 15, scoreWait: 1400, verifyEvery: 8, maxLogLines: 400, dryStreak: 6, dryWindow: 60000 };
  const VT_SETTLE_POLLS = 16;  /* hard cap ~16s, so Stop can never hang */
  const VT_SETTLE_EVERY = 1000; /* one read a second */
  const VT_SETTLE_MIN = 8;       /* at least ~8s before stability may end it */
  const VT_SETTLE_STABLE = 3;    /* three agreeing reads, not two */
  const MAP_KEY = 'epMPmap:';
  /* map records are also localStorage, so they are untrusted too. m.structured,
     m.lists and m.classic are written into card meta without esc(), so a forged
     record would inject markup. Coerce every count to a finite number and keep
     only records with a usable id; anything else is dropped. */
  const num = (v) => {
    let n = v;
    if (typeof v === 'string') { if (v.trim() === '') return 0; n = Number(v); }
    else if (typeof v !== 'number') return 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const normMap = (r) => {
    if (!Array.isArray(r)) return null;
    const out = [];
    for (const m of r) {
      if (!m || typeof m !== 'object') continue;
      const id = Number(m.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      out.push({
        id: id,
        name: String(m.name == null ? '' : m.name),
        subject: String(m.subject == null ? '' : m.subject),
        official: !!m.official, personal: !!m.personal,
        lists: num(m.lists), structured: num(m.structured), classic: num(m.classic),
        estimated: num(m.estimated), avgQ: num(m.avgQ), attemptedLists: num(m.attemptedLists),
        probed: num(m.probed),
        freshRatio: Number.isFinite(m.freshRatio) ? m.freshRatio : undefined,
        ids: Array.isArray(m.ids) ? m.ids.filter(x => { if (typeof x === 'string') return x.trim() !== '' && Number.isFinite(Number(x)); return typeof x === 'number' && Number.isFinite(x); }).map(Number) : []
      });
    }
    return out.length ? out : null;
  };
  const loadMap = () => { try { return normMap(JSON.parse(lsGet(MAP_KEY + (ID.user || 'anon')) || 'null')); } catch (_) { return null; } };
  const PT_PER_Q = 0.75;
  async function buildMap(catalog, onProgress) {
    const out = [];
    let i = 0;
    const total = catalog.length;
    const report = () => { if (typeof onProgress === 'function') onProgress(out.length, total); };
    const lanes = Array.from({ length: 14 }, async () => {
      while (i < catalog.length) {
        const m = catalog[i++];
        const rec = { id: m.id, name: m.name, subject: m.subject, official: m.official, personal: m.personal, lists: 0, structured: 0, classic: 0, estimated: 0, avgQ: 0, attemptedLists: 0, probed: 0, ids: [] };
        const j = await A(NS + 'GetModuleActivitiesForBrowsingWithSchoolId', [{ ActivityType: 0, ModuleID: m.id, ModuleType: 1, FilterString: '', SkipCount: 0, TakeCount: 2000 }, ID.school], 40000);
        const acts = (j && j.result && j.result.Activities) || [];
        rec.lists = acts.length;
        const st = acts.filter(a => a.ActivityType === 5);
        rec.structured = st.length;
        rec.classic = acts.length - st.length;
        rec.ids = st.map(a => a.ID);
        if (!st.length) { rec.estimated = 0; rec.avgQ = 0; out.push(rec); report(); continue; }
        const samples = [];
        const probe = st.length <= 3 ? st : [st[0], st[Math.floor(st.length / 2)], st[st.length - 1]];
        for (const a of probe) {
          const s = await A(NS + 'GetStructuredActivityAndAttempts2WithSchoolId', [{ ActivityID: a.ID, TaskID: urlTask || null }, ID.school], 20000);
          const n = (s && s.result && s.result.Attempts || []).length;
          if (n) rec.attemptedLists++;
          const act = s && s.result && s.result.Activity;
          if (!act) continue;
          const seen = {};
          const walk = x => { if (x.ContentIDs) for (const c of x.ContentIDs) seen[c] = 1; if (x.Children) for (const c of x.Children) walk(c); };
          walk(act.Structure || {});
          samples.push(Object.keys(seen).length);
        }
        rec.avgQ = samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0;
        /* probed = lists we actually asked about, not lists that answered.
           A list with no readable Structure still counts as probed, otherwise
           coverage silently shrinks and a half-touched module reads as a
           full census. */
        rec.probed = probe.length;
        rec.freshRatio = rec.probed ? Math.max(0, (rec.probed - rec.attemptedLists) / rec.probed) : 1;
        rec.estimated = Math.round(rec.avgQ * rec.structured * rec.freshRatio);
        rec.ptsPerList = rec.avgQ ? Math.round(rec.avgQ * PT_PER_Q) : 0;
        out.push(rec);
        report();
      }
    });
    await Promise.all(lanes);
    out.sort((a, b) => b.estimated - a.estimated);
    return out;
  }

  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const A = async (m, p, ms) => {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), ms || 20000);
    try {
      const r = await fetch(API + '/json.rpc?target=' + encodeURIComponent(m), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }),
        signal: ctl.signal
      });
      const t = await r.text();
      try { return JSON.parse(t); } catch (_) { return { err: 'HTTP ' + r.status }; }
    } catch (e) { return { err: String((e && e.message) || e) }; }
    finally { clearTimeout(to); }
  };
  const jget = async (url) => { try { const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json', 'EP-Require-Preflight': '1' } }); return JSON.parse(await r.text()); } catch (_) { return null; } };
  const jpost = async (url, body) => { try { const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'EP-Require-Preflight': '1' }, body: JSON.stringify(body) }); return JSON.parse(await r.text()); } catch (_) { return null; } };
  const gqlQ = async (query) => { try { const r = await fetch(GQL, { method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) }); return JSON.parse(await r.text()); } catch (_) { return null; } };

  const urlTask = parseInt(new URLSearchParams(location.search).get('task') || '0', 10) || 0;
  function pageModule() { const pp = location.pathname.split('/'); const m = parseInt(pp[3] || '0', 10); return m > 0 ? m : 0; }

  async function resolveIdentity() {
    const me = await jget('https://authentication.educationperfect.com/me');
    if (me) {
      ID.uuid = me.UserId || null;
      ID.user = me.UserIDLegacy || me.UserIdLegacy || null;
      ID.type = me.UserType || 'unknown';
      ID.name = ((me.FirstName || '') + ' ' + (me.LastName || '')).trim() || null;
      /* /me answered but carried no numeric id: the denylist keys on that, so
         say so rather than leaving a blank User ID field */
      if (!ID.user) vtWhy('no UserIDLegacy on /me');
    } else {
      vtWhy('/me unavailable (not logged in?)');
    }
    const sess = await jpost(API + '/legacy/session', { ApplicationId: 'EducationPerfectPro', LtiLaunchEventId: null });
    if (sess) {
      ID.session = sess.SessionId || null;
      if (!ID.user && sess.UserId) { ID.user = sess.UserId; vtWhy('user id from session fallback'); }
    } else {
      vtWhy('/legacy/session failed');
    }
    const schools = await jget(API + '/legacy/school');
    if (schools && Array.isArray(schools.SchoolDetails) && schools.SchoolDetails.length) {
      let chosen = schools.SchoolDetails[0];
      try {
        const sel = localStorage.getItem('EP_SELECTED_SCHOOL_' + (ID.uuid || '')) || '';
        if (sel) { const m = schools.SchoolDetails.find(s => (s.Id || '') === sel || (s.Guid || '') === sel); if (m) chosen = m; }
      } catch (_) { /* ignore */ }
      ID.school = chosen.InternalId || chosen.Id || ID.school;
    } else {
      vtWhy('/legacy/school returned nothing');
    }
    try { const ov = parseInt(localStorage.getItem('epMPschool') || '0', 10); if (ov) ID.school = ov; } catch (_) { /* ignore */ }
    if (!ID.school) { ID.school = 6133; vtWhy('school defaulted to 6133'); }
    if (ID.class == null) ID.class = -1;
    try { const o = localStorage.getItem('epMPorg'); if (o) ID.org = o; } catch (_) { /* ignore */ }
    if (!ID.org && ID.uuid) { try { const v = localStorage.getItem('EP_SELECTED_SCHOOL_' + ID.uuid); if (v && /^[0-9a-f-]{36}$/i.test(v)) ID.org = v; } catch (_) { /* ignore */ } }
    if (!ID.org) { try { for (const k of Object.keys(localStorage)) { if (k.indexOf('EP_SELECTED_SCHOOL_') === 0) { const v = localStorage.getItem(k); if (v && /^[0-9a-f-]{36}$/i.test(v)) { ID.org = v; break; } } } } catch (_) { /* ignore */ } }
    return ID;
  }

  const CONTEXT_CANDIDATES = [
    () => ({ FolderFilter: '', ModuleID: pageModule() || 0, ListIDs: [], TaskID: urlTask || null }),
    () => { const m = modCatalog.find(x => Array.isArray(x.ids) && x.ids.length); return { FolderFilter: '', ModuleID: m ? m.id : 0, ListIDs: m && m.ids.length ? [m.ids[0]] : [], TaskID: null }; },
    () => { const m = modCatalog.find(x => x.structured > 0); return { FolderFilter: '', ModuleID: m ? m.id : 0, ListIDs: [], TaskID: null }; },
    () => ({ FolderFilter: '', ModuleID: 0, ListIDs: [], TaskID: null })
  ];
  async function usList() {
    if (ID.us) return ID.us;
    const cands = [];
    if (window.__epSniff && window.__epSniff.us) cands.push(window.__epSniff.us);
    if (ID.session) cands.push(ID.session);
    cands.push(...FALLBACK_US);
    const base = { SelectedClassID: ID.class != null ? ID.class : -1, DataSetSelectionOptions: { SelectionType: 1, RestrictToActiveDataSets: true, TargetIDs: null }, CompetitionCode: null };
    const faults = [];
    for (const mk of CONTEXT_CANDIDATES) {
      const ctx = Object.assign({}, base, { ActivitySelectionOptions: mk() });
      for (const us of cands) {
        const j = await A(NS + 'SelectAppContextAndGetDataWithSchoolId', [us, ctx, ID.school], 8000);
        const res = j && j.result;
        if (res && (res.Success || (res.UserType && !res.Fault))) {
          ID.us = us;
          window.__epSniff && (window.__epSniff.us = us);
          if (!ID.org && res.ClassAndSchool && res.ClassAndSchool.OrganisationId) ID.org = res.ClassAndSchool.OrganisationId;
          return us;
        }
        if (j && j.err) faults.push(String(j.err).slice(0, 40));
        if (j && j.result && j.result.Fault) faults.push(String(j.result.Fault).slice(0, 40));
      }
    }
    log('us FAILED to resolve — store writes will be rejected (' + [...new Set(faults)].slice(0, 2).join(' | ') + ')');
    ID.us = cands[0];
    return ID.us;
  }

  // ---- UI ------------------------------------------------------------------
/* Grain · minimal console — UI layer only
   design C: title + phase line + detail line + Start/Stop + collapsible 3-line log tail
   picker (☰) kept top-right; no target input; engine below is unchanged. */
const STYLE = `
#az-ui,#az-ui *{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-user-select:auto;user-select:auto}
/* â”€â”€ num2 dock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   #az-ui is a container and NOTHING else. In production it is an opaque
   fullscreen box, which means the tool covers the page and eats every click
   meant for Education Perfect. pointer-events:none here, auto on each window,
   is what hands the page back. No background, no overflow clip. */
#az-ui{position:fixed;inset:0;z-index:999999;pointer-events:none;color:#f2f2f2}
#az-box{position:fixed;pointer-events:auto;width:340px;max-width:calc(100vw - 20px);
  padding:0;display:flex;flex-direction:column;
  /* Barely translucent with a blur behind it. The alpha stays high so text
     reads against any page underneath. */
  background:rgba(17,17,17,.96);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  background:rgba(17,17,17,.96);
  border:1px solid #2a2a2a;border-radius:14px;box-shadow:0 18px 50px rgb(0 0 0 / .5)}
/* the bar: dot, name, status, minimise, modules. #az-min and #az-menu are both
   .az-iconbtn so the two controls match each other exactly. */
#az-bar{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 12px}
#az-bar.is-handle{cursor:grab}
#az-bar.is-handle:active{cursor:grabbing}
#az-dot{width:8px;height:8px;border-radius:50%;flex:none;background:#4d4d4d;
  transition:background .2s ease,box-shadow .2s ease}
#az-box[data-dot="scan"] #az-dot{background:#e0b64a;animation:vt-pulse 1.6s ease-in-out infinite}
#az-box[data-dot="run"] #az-dot{background:#7ac07a;box-shadow:0 0 9px rgb(122 192 122 / .7)}
#az-box[data-dot="done"] #az-dot{background:#7ac07a}
#az-box[data-dot="err"] #az-dot{background:#e06c6c;box-shadow:0 0 9px rgb(224 108 108 / .7)}
@keyframes vt-pulse{0%,100%{opacity:1}50%{opacity:.35}}
#az-bar-t{font:600 13px/1 'Inter',system-ui,sans-serif;color:#f2f2f2;
  letter-spacing:-.01em;flex:none}
#az-barphase{flex:1;min-width:0;font:11px/1 ui-monospace,Consolas,monospace;color:#8a8a8a;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#az-box[data-dot="run"] #az-barphase{color:#7ac07a}
#az-box[data-dot="done"] #az-barphase{color:#7ac07a}
#az-box[data-dot="err"] #az-barphase{color:#e06c6c}
#az-box[data-dot="scan"] #az-barphase{color:#e0b64a}
/* the one-line console, on screen expanded or not */
#az-dock{padding:0 12px 9px}
#az-dockline{display:block;font:11px/1.45 ui-monospace,'Cascadia Mono',Consolas,monospace;
  color:#5a5a5a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#az-dockline.is-good{color:#7ac07a}
#az-dockline.is-err{color:#e06c6c}
/* collapsed keeps the window, the position and the dot */
#az-box.is-min{width:340px}
/* collapsed, there is no log on screen to filter - the one-line dock summary
   is the whole point of collapsing, so the cycle button goes with it */
#az-box.is-min #az-chev{display:none}
/* grid-template-rows 1fr -> 0fr animates to whatever the content height is,
   so no magic pixel value is baked in. display:none cannot be transitioned,
   which is why the body needs a wrapper. */
#az-bodywrap{display:grid;grid-template-rows:1fr;min-height:0;
  transition:grid-template-rows .26s cubic-bezier(.4,0,.2,1)}
#az-box.is-min #az-bodywrap{grid-template-rows:0fr}
#az-body{position:relative;overflow:hidden;min-height:0;
  display:flex;flex-direction:column;align-items:center;gap:14px;
  padding:20px 22px 22px;border-top:1px solid #2a2a2a;
  transition:padding .26s cubic-bezier(.4,0,.2,1)}
/* the body collapsing to zero content height still renders its own padding and
   border - 42px plus 1px of dead strip - so those come off too */
#az-box.is-min #az-body{padding-top:0;padding-bottom:0;border-top-width:0}
/* the console line belongs to the collapsed form, and it fades rather than
   display:none so the transition is visible */
#az-dock{max-height:40px;opacity:1;overflow:hidden;
  transition:max-height .26s cubic-bezier(.4,0,.2,1),opacity .18s ease,padding .26s ease}
#az-box:not(.is-min) #az-dock{max-height:0;opacity:0;padding-top:0;padding-bottom:0}
/* expanded: the bar is just the two controls. The text and the dot fade out;
   #az-barphase is flex:1 so the buttons never move as text comes and goes. */
#az-dot,#az-bar-t,#az-barphase{transition:opacity .18s ease}
#az-box:not(.is-min) #az-dot,#az-box:not(.is-min) #az-bar-t,#az-box:not(.is-min) #az-barphase{opacity:0}
/* both windows arrive rather than pop */
@keyframes az-in{from{opacity:0;transform:scale(.97) translateY(-8px)}to{opacity:1;transform:none}}
#az-box,.az-modal{animation:az-in .22s cubic-bezier(.2,.8,.2,1)}
#az-hero{display:flex;align-items:baseline;justify-content:center;gap:6px;
  font:600 38px/1 'Inter',system-ui,sans-serif;letter-spacing:-.03em;color:#e0b64a;
  font-variant-numeric:tabular-nums;margin:2px 0 0}
#az-hero small{font:600 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.1em;color:#4d4d4d}
/* tabular figures: without this the whole hero shuffles sideways every time a
   digit changes width, which is the one thing a number must never do */
#az-meter{width:100%;height:3px;margin:16px 0 5px;background:#1f1f1f;border-radius:2px;overflow:hidden}
#az-meter i{display:block;height:100%;width:0;border-radius:2px;
  background:linear-gradient(90deg,#e0b64a,#f0cd6a);transition:width .3s cubic-bezier(.4,0,.2,1)}
#az-sub{display:flex;justify-content:space-between;width:100%;
  font:10px/1 ui-monospace,Consolas,monospace;color:#4d4d4d}
#az-phase{font-size:13px;letter-spacing:.01em;color:#8a8a8a;text-align:center;min-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
#az-phase.is-earn,#az-phase.is-done{color:#7ac07a}
#az-phase.is-err{color:#e06c6c}
#az-phase.is-scan{color:#e0b64a}
#az-detail{font-size:12px;letter-spacing:.01em;color:#4d4d4d;text-align:center;min-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
#az-detail.is-earn,#az-detail.is-done{color:#7ac07a}
#az-detail.is-err{color:#e06c6c}
.az-btn{appearance:none;border:1px solid #e0b64a;background:#e0b64a;color:#151005;font:600 14px/1 'Inter',system-ui,sans-serif;letter-spacing:.01em;padding:10px 24px;border-radius:999px;cursor:pointer;min-width:132px;transition:background .12s ease,transform .1s ease}
.az-btn:hover{background:#f0cd6a;border-color:#f0cd6a}
.az-btn:active{transform:scale(.98)}
.az-btn:focus-visible{outline:3px solid #e0b64a;outline-offset:3px}
.az-btn.is-stop{background:transparent;color:#8a8a8a;border-color:#2a2a2a}
.az-btn.is-stop:hover{color:#f2f2f2;border-color:#3d3d3d;background:transparent}
#az-rule{width:100%;height:1px;background:#2a2a2a;border:0;margin:0}
#az-log{width:100%;max-height:62px;overflow:hidden;transition:max-height .18s ease}
#az-log.is-open{max-height:230px;overflow:auto;scrollbar-width:thin;scrollbar-color:#2a2a2a transparent}
  #az-log.is-full{max-height:min(52vh,360px);overflow:auto;scrollbar-width:thin;scrollbar-color:#2a2a2a transparent}
  #az-log.is-full .az-logrow .az-m{white-space:pre-wrap;word-break:break-word}
  #az-logbar{display:none;align-items:center;gap:10px;padding:0 0 8px}
  #az-log.is-full + #az-logbar{display:flex}
  /* same shape as .az-chip-btn (select all / clear / remap) so the row reads as
     part of the panel; gold is the panel's only accent */
  #az-copy{appearance:none;border:1px solid #2a2a2a;border-radius:9px;background:#1a1a1a;
    color:#8a8a8a;font:600 11px 'Inter',system-ui,sans-serif;padding:6px 10px;
    cursor:pointer;white-space:nowrap;transition:color .12s ease,border-color .12s ease}
  #az-copy:hover{color:#e0b64a;border-color:#4d3f1e}
  #az-copy:focus-visible{outline:2px solid #e0b64a;outline-offset:2px}
  #az-lognote{font:500 11px 'Inter',system-ui,sans-serif;color:#4d4d4d}
/* ── update notice ───────────────────────────────────────────────────────
   Hidden until vtUpdShow() adds .is-on, so the panel never reserves space for
   it. It closes on the × or after VT_UPD_MS, and either way it is gone for
   good: the marker was written the instant it appeared, so nothing here can
   bring it back. */
#az-upd{display:none;position:absolute;top:14px;right:14px;width:264px;padding:13px 15px;flex-direction:column;gap:7px;background:#131313;border:1px solid #4d3f1e;border-radius:13px;box-shadow:0 14px 40px rgb(0 0 0 / .55);animation:vt-upd .22s ease-out}
#az-upd.is-on{display:flex}
/* the exit, on top of the entry: same specificity, declared later, so it wins
   and the notice leaves upward rather than flashing back in */
#az-upd.is-out{animation:vt-upd-out .3s cubic-bezier(.4,0,1,1) forwards;pointer-events:none}
@keyframes vt-upd{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes vt-upd-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-180%)}}
#az-upd-h{display:flex;align-items:center;gap:9px}
#az-upd-dot{width:7px;height:7px;border-radius:50%;background:#e0b64a;box-shadow:0 0 9px rgb(224 182 74 / .75);animation:vt-upd-pulse 1.9s ease-in-out infinite;flex:none}
@keyframes vt-upd-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}
#az-upd-t{flex:1;min-width:0;font:700 14px/1 'Inter',system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#e0b64a;text-shadow:0 0 18px rgb(224 182 74 / .35)}
#az-upd-x{appearance:none;width:18px;height:18px;flex:none;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid transparent;border-radius:5px;color:#4d4d4d;font:14px/1 'Inter',system-ui,sans-serif;cursor:pointer;padding:0;transition:color .12s ease,background .12s ease}
#az-upd-x:hover{color:#f2f2f2;background:#1a1a1a}
#az-upd-x:focus-visible{outline:2px solid #e0b64a;outline-offset:2px}
#az-upd-d{font:12.5px/1.5 'Inter',system-ui,sans-serif;color:#8a8a8a}
#az-upd-d s{color:#4d4d4d;text-decoration:line-through;margin-right:2px}
#az-upd-d b{color:#f2f2f2;font-weight:600}
#az-log::-webkit-scrollbar{width:8px}
#az-log::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:4px}
.az-logrow{display:flex;gap:8px;font:11px/1.55 ui-monospace,'Cascadia Mono',Consolas,monospace;color:#4d4d4d;white-space:nowrap}
.az-logrow .az-t{color:#3a3a3a;flex:none}
.az-logrow .az-m{overflow:hidden;text-overflow:ellipsis}
.az-logrow.is-good .az-m{color:#7ac07a}
.az-logrow.is-err .az-m{color:#e06c6c}
.az-iconbtn{position:relative;top:auto;left:auto;right:auto;flex:none;width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid transparent;border-radius:8px;color:#4d4d4d;cursor:pointer;font:14px/1 'Inter',system-ui,sans-serif;transition:color .12s ease,border-color .12s ease,transform .18s ease}
.az-iconbtn:hover{color:#f2f2f2;border-color:#2a2a2a}
.az-iconbtn:focus-visible{outline:2px solid #e0b64a;outline-offset:2px}
#az-chev{order:-1;margin-right:2px;font-size:13px}
#az-chev[aria-expanded="true"]{transform:rotate(180deg)}
#az-menu{right:14px}
#az-picker{position:fixed;inset:0;z-index:9999999;pointer-events:none}
#az-picker.hidden{display:none}
/* height, not just max-height: the modal used to size to its content, so it
   collapsed to ~175px while modules were discovering and jumped to ~506px once
   they loaded. Pinning it to 80vh is the same size the loaded state already
   reached, so the grid area is a stable 413px in every state. */
.az-modal{position:fixed;pointer-events:auto;width:min(760px,calc(100vw - 24px));height:62vh;max-height:62vh;display:flex;flex-direction:column;background:rgba(17,17,17,.96);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid #2a2a2a;border-radius:14px;box-shadow:0 24px 80px rgb(0 0 0 / .6);overflow:hidden}
.az-modal-head.is-handle{cursor:grab}
.az-modal-head.is-handle:active{cursor:grabbing}
.az-modal.is-min{height:auto;max-height:none}
.az-modal.is-min #az-pbody{opacity:0;pointer-events:none}
.az-modal.is-min .az-modal-head{border-bottom:0}
/* The picker minimised as a hard snap: display:none cannot be transitioned, so
   the whole panel vanished in one frame while the dock beside it glided.
   The head is measured at click time and handed to max-height, which IS
   animatable, so the window folds down to its own header with the head still
   showing - no magic pixel height baked into the CSS. */
.az-modal{transition:max-height .26s cubic-bezier(.4,0,.2,1)}
#az-pbody{transition:opacity .15s ease}
/* closing gets its own exit, and the wrapper is only display:none'd once it has
   finished - otherwise the animation would never be seen */
@keyframes az-out{from{opacity:1;transform:none}to{opacity:0;transform:scale(.97) translateY(-8px)}}
#az-picker.is-closing .az-modal{animation:az-out .18s cubic-bezier(.4,0,1,1) forwards}
.az-modal-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #2a2a2a}
.az-modal-head h2{font:600 16px/1 'Inter',system-ui,sans-serif;color:#f2f2f2;margin:0;letter-spacing:-.01em}
.az-modal-head input{flex:1;min-width:0;padding:7px 10px;border:1px solid #2a2a2a;border-radius:9px;background:#1a1a1a;color:#f2f2f2;font:12px ui-monospace,Consolas,monospace;outline:none}
.az-chip-btn{border:1px solid #2a2a2a;border-radius:9px;background:#1a1a1a;color:#8a8a8a;font:600 11px 'Inter',system-ui,sans-serif;padding:6px 10px;cursor:pointer;white-space:nowrap}
.az-chip-btn:hover{color:#f2f2f2;border-color:#3d3d3d}
.az-close{background:transparent;border:none;color:#8a8a8a;font:16px ui-monospace,monospace;cursor:pointer;padding:4px 8px}
.az-close:hover{color:#f2f2f2}
#az-modgrid{overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin;scrollbar-color:#2a2a2a transparent}
.az-card{display:flex;gap:10px;align-items:flex-start;border:1px solid #2a2a2a;border-radius:10px;padding:10px 12px;background:#1a1a1a;cursor:pointer}
.az-card:hover{border-color:#4d3f1e}
.az-card.complete{border-color:#5c2f2f;background:#1f1616}
.az-card input{position:relative;top:2px;accent-color:#e0b64a;width:15px;height:15px;flex:none;cursor:pointer}
.az-card-body{flex:1;min-width:0}
.az-card-name{font:600 13px/1.4 'Inter',system-ui,sans-serif;color:#f2f2f2;word-break:break-word}
.az-card-complete-chip{margin-left:6px;color:#e06c6c;font:700 9px ui-monospace,monospace;letter-spacing:.08em}
.az-card-tags{margin-top:3px;display:flex;gap:6px;flex-wrap:wrap}
.az-tag{font:9px ui-monospace,monospace;letter-spacing:.05em;text-transform:uppercase;padding:2px 6px;border-radius:5px;border:1px solid #2a2a2a;color:#4d4d4d}
.az-tag.official{color:#e0b64a;border-color:#4d3f1e}
.az-card-meta{font:10px ui-monospace,monospace;color:#4d4d4d;margin-top:5px}
.az-card-meta b{color:#8a8a8a}
.az-modal-foot{padding:10px 16px;border-top:1px solid #2a2a2a;color:#4d4d4d;font:11px ui-monospace,monospace;display:flex;justify-content:space-between;align-items:center}
#az-pbody{flex:1;min-height:0;display:flex;flex-direction:column}
#az-mapwrap{position:relative;display:flex;flex:1;min-height:0;overflow:hidden}
#az-modgrid{flex:1;min-height:0}
#az-mapload{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:16px;background:#111111}
#az-mapload.is-on{display:flex}
#az-mapload .az-ring{width:34px;height:34px;border-radius:50%;border:3px solid rgba(224,182,74,.14);border-top-color:#e0b64a;animation:vt-spin .8s linear infinite;box-sizing:border-box}
@keyframes vt-spin{to{transform:rotate(360deg)}}
#az-mapload .az-maplabel{font:500 15px/1.3 Inter,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:-.01em;color:#ededed;animation:vt-fade .25s ease-out;text-align:center;padding:0 16px}
@keyframes vt-fade{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
#az-mapload .az-mapcount{font:500 13px/1.3 Inter,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.02em;color:#e0b64a;font-variant-numeric:tabular-nums}
#az-mapload .az-dots{display:inline-block;width:1.2em;text-align:left;overflow:hidden;vertical-align:bottom}
#az-mapload .az-mapnote{font:400 13px/1.5 Inter,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e06c6c;max-width:300px;text-align:center;padding:0 16px}
@media (prefers-reduced-motion:reduce){#az-mapload .az-ring{animation:none}#az-mapload .az-maplabel{animation:none}}

#az-phase{transition:opacity .12s ease,transform .12s ease}
#az-box.is-running #az-phase{color:#e0b64a}
#az-phase.is-swap{opacity:0;transform:translateY(3px)}
#az-phase{animation:none}
#az-box.is-running #az-phase{color:#e0b64a}

#az-detail{transition:color .4s ease,background-color .4s ease;border-radius:6px;padding:0 4px}
#az-detail.is-earn-flash{color:#7ac07a}
#az-box{transition:border-color .2s ease,box-shadow .2s ease}
#az-box.is-running{border-color:rgba(224,182,74,.4);box-shadow:0 0 0 1px rgba(224,182,74,.12),0 12px 48px rgba(0,0,0,.4)}
#az-box.is-error{animation:vt-err .3s ease 2;border-color:#5c2f2f}
@keyframes vt-err{0%,100%{box-shadow:0 0 0 0 rgba(224,108,108,0)}50%{box-shadow:0 0 0 3px rgba(224,108,108,.22)}}
.az-logrow{animation:vt-row .14s ease-out}
@keyframes vt-phase{from{opacity:.25;transform:translateY(2px)}to{opacity:1;transform:none}}
@keyframes vt-row{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
#az-log{cursor:pointer}
#az-chev{width:auto;min-width:28px;padding:0 8px;font:9px/1 ui-monospace,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}
#az-chev-l{pointer-events:none}
  #az-chev[data-mode="points"]{color:#e0b64a;border-color:#4d3f1e}
  #az-chev[data-mode="errors"]{color:#e06c6c;border-color:#5c2f2f}
  #az-chev[data-mode="full"]{color:#8ab4f8;border-color:#2a3f5c}
#az-ui{animation:vt-in .15s ease-out}
@keyframes vt-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){#az-ui,.az-logrow,#az-box{animation:none!important}#az-phase,#az-detail,#az-box,#az-log,.az-iconbtn{transition:none!important}#az-upd{animation:none!important}#az-upd-dot{animation:none!important}
  /* the collapse and the arrival both stop travelling, but the collapsed
     state must still be reachable and the dock line must still go away */
  #az-box,.az-modal{animation:none!important}
  #az-bodywrap{transition:none!important}
  #az-dock{transition:none!important}
  #az-dot,#az-bar-t,#az-barphase{transition:none!important}
  /* the picker fold and the new exit stop travelling too */
  .az-modal{transition:none!important}
  #az-pbody{transition:none!important}
  #az-picker.is-closing .az-modal{animation:none!important}}
/* reduced motion still has to HIDE the notice on time - the class removal is
   what does that, so only the travel is dropped, not the 15s deadline */
`;

  const HTML = `
<div id="az-ui">
  <div id="az-box" data-dot="idle">
    <div id="az-bar">
      <span id="az-dot"></span>
      <span id="az-bar-t">Verity</span>
      <span id="az-barphase">idle</span>
      <button id="az-chev" class="az-iconbtn" title="cycle log view: all / points / errors / full debug log"><span id="az-chev-l">all</span></button>
      <button id="az-min" class="az-iconbtn" aria-label="minimise" title="minimise">-</button>
      <button id="az-menu" class="az-iconbtn" aria-label="modules" title="modules">\u2630</button>
    </div>
    <div id="az-dock"><span id="az-dockline"></span></div>
    <div id="az-bodywrap">
    <div id="az-body">
    <div id="az-hero"><span id="az-score">—</span><small>PTS</small></div>
    <div id="az-phase">idle</div>
    <div id="az-meter"><i id="az-meter-fill"></i></div>
    <div id="az-sub"><span id="az-lists">0 lists done</span><span id="az-user"></span></div>
    <div id="az-detail"></div>
    <button id="az-primary" class="az-btn">Start</button>
    <hr id="az-rule">
    <div id="az-log"></div>
    <div id="az-logbar">
      <button id="az-copy" type="button" title="copy the whole log">copy log</button>
      <span id="az-lognote"></span>
    </div>
    </div>
    </div>
  </div>
  <div id="az-upd">
    <div id="az-upd-h"><span id="az-upd-dot"></span><span id="az-upd-t">UPDATED!!</span><button id="az-upd-x" type="button" aria-label="dismiss update notice">\u00d7</button></div>
    <div id="az-upd-d">ur build has been updated <s id="az-upd-o"></s> <span id="az-upd-a">-&gt;</span> <b id="az-upd-n"></b></div>
  </div>
  <div id="az-picker" class="hidden">
    <div class="az-modal">
      <div class="az-modal-head" id="az-phead">
        <h2>Modules</h2>
        <input id="az-search" type="text" placeholder="filter\u2026" aria-label="filter modules">
        <button id="az-selall" class="az-chip-btn">select all</button>
        <button id="az-selnone" class="az-chip-btn">clear</button>
        <button id="az-remap" class="az-chip-btn" title="rebuild module map">remap</button>
        <button id="az-pmin" class="az-iconbtn" aria-label="minimise modules" title="minimise">-</button>
        <button id="az-close" class="az-iconbtn" aria-label="close modules" title="close">\u00d7</button>
      </div>
      <div id="az-pbody">
      <div id="az-mapwrap">
        <div id="az-modgrid"></div>
        <div id="az-mapload">
          <div class="az-ring"></div>
          <div class="az-maplabel"><span id="az-maptext">remapping modules</span><span class="az-dots" id="az-mapdots"></span></div>
          <div class="az-mapcount" id="az-mapcount"></div>
          <div class="az-mapnote" id="az-mapnote" style="display:none"></div>
        </div>
      </div>
      <div class="az-modal-foot"><span id="az-selcount">0 selected</span><span id="az-gridstate"></span></div>
      </div>
    </div>
  </div>
</div>
`;


  try {
    const _sb = document.createElement('style');
    _sb.id = 'vt-scrollbars';
    _sb.textContent = "\n/* site-wide transparent scrollbars (whole EP app, not just the panel) */\n{scrollbar-width:thin;scrollbar-color:transparent transparent}\n::-webkit-scrollbar{width:10px;height:10px;background:transparent}\n::-webkit-scrollbar-track{background:transparent;border:0}\n::-webkit-scrollbar-corner{background:transparent}\n::-webkit-scrollbar-thumb{background:transparent;border-radius:6px}\n::-webkit-scrollbar-thumb:hover{background:rgba(224,182,74,.32)}\n";
    (document.head || document.documentElement).appendChild(_sb);
  } catch (_) { /* ignore */ }

  const $ = id => document.getElementById(id);
  let timeEl = null, markStart = null, timerId = null, running = false;
  function fmtMs(ms) { return (Math.max(0, ms | 0) / 1000).toFixed(1) + 's'; }
  function getTimeEl() { if (timeEl && timeEl.isConnected) return timeEl; timeEl = document.getElementById('az-time'); return timeEl; }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } if (markStart != null) { const ms = Date.now() - markStart; const e = getTimeEl(); if (e) e.textContent = fmtMs(ms); return fmtMs(ms); } return null; }
  function startTimer() { if (timerId) return; markStart = Date.now(); const t = function () { const e = getTimeEl(); if (e) e.textContent = fmtMs(Date.now() - markStart); }; t(); timerId = setInterval(t, 100); }

  const phase = { cur: 'idle', mod: 0, list: 0, total: 0, score: null, target: 0, lastDelta: 0, rate: 0, doneTotal: 0, modsTotal: 0, qTotal: 0 };
  let detailText = '';
  function fmtMs(ms) { return (Math.max(0, ms | 0) / 1000).toFixed(1) + 's'; }
  const sc = (n) => (n === null || n === undefined) ? '\u2014' : Number(n).toLocaleString('en-US');
  /* The score has its own hero line now. Repeating it here put the same
     number directly under itself - the hero read 481,829 and the line under
     it read SETTLE - 481,829. The collapsed bar still wants the number, so
     azBarPhase composes it there instead of phaseText carrying it for
     everyone. */
  function phaseText() {
    if (phase.cur === 'run') return 'RUN \u00b7 ' + phase.mod + ' \u00b7 ' + phase.list + '/' + phase.total + ' \u00b7 ' + phase.rate + ' Qt/s';
    if (phase.cur === 'scan') return 'SCAN \u00b7 ' + phase.mod;
    if (phase.cur === 'ready') return 'READY \u00b7 ' + phase.modsTotal + ' modules';
    if (phase.cur === 'earn') return '+' + sc(phase.lastDelta) + 'pt \u00b7 ' + phase.rate + ' Qt/s';
    if (phase.cur === 'settle') return 'SETTLE \u00b7 ' + phase.rate + ' Qt/s';
    if (phase.cur === 'done') return 'done \u00b7 ' + phase.rate + ' Qt/s';
    if (phase.cur === 'err') return 'error \u00b7 ' + sc(phase.score);
    return 'idle \u00b7 ' + phase.rate + ' Qt/s';
  }
  let lastKind = null, lastPhaseAt = 0;
  function renderStatus() {
    const p = $('az-phase'), d = $('az-detail');
    if (p) {
      const now = Date.now();
      const kind = phase.cur;
      if (kind !== lastKind) {
        lastKind = kind;
        lastPhaseAt = now;
        const t = phaseText();
        p.classList.add('is-swap');
        setTimeout(() => {
          p.textContent = t;
          p.className = 'is-' + phase.cur;
          p.style.animation = 'none'; void p.offsetWidth; p.style.animation = 'vt-phase .16s ease-out';
          setBoxState();
        }, 60);
      } else if (now - lastPhaseAt > 400) {
        lastPhaseAt = now;
        p.textContent = phaseText();
        p.className = 'is-' + phase.cur;
      }
    }
    azBarPhase();
    azDot();
    /* Option A: the score is the product, so it gets the hero slot in tabular
       figures and everything else shrinks around it. Every field it needs was
       already in phase - it was just arriving as one grey sentence. A null
       score before the first verify tick must read as a dash, not a zero. */
    const hero = $('az-score');
    if (hero) {
      /* phase.score only moves on a verify tick, which is every eighth list.
         state.lastScore is read up front the moment a run starts, so fall back
         to it - otherwise the hero sits on a dash for the whole first tick even
         though the number has been on screen the entire time. */
      const v = (phase.score === null || phase.score === undefined)
        ? (state && state.lastScore) : phase.score;
      hero.textContent = (v === null || v === undefined) ? '—' : sc(v);
    }
    const fill = $('az-meter-fill');
    if (fill) {
      /* per-module progress: phase.list walks this module's todo and phase.total
         is its length, so the meter reaches the end when the module finishes.
         phase.doneTotal is the lifetime count across every module and belongs
         in the row underneath, not in this ratio. */
      const tot = phase.total || 0, run = phase.list || 0;
      fill.style.width = (tot > 0 ? Math.min(100, Math.round(run / tot * 100)) : 0) + '%';
    }
    const lists = $('az-lists');
    if (lists) lists.textContent = (phase.doneTotal || 0) + ' lists done';
    const usr = $('az-user');
    if (usr) usr.textContent = ID.user ? 'user ' + ID.user : '';
    if (d) {
      const bits = [];
      if (phase.lastDelta > 0) bits.push('+' + sc(phase.lastDelta) + 'pt');
      /* user and the list count have their own row now. Repeating them here is
         what pushed "waiting for EP to post points" off the end of the line and
         left it truncating mid-word. */
      const stale = vtCfgStaleLabel();
      if (stale) bits.push(stale);
      if (detailText) bits.push(detailText);
      /* undelivered webhook cards, so a blocked network is visible instead of
         looking identical to "nothing happened" */
      const pending = vtOutboxPending();
      if (pending) bits.push((vtBlocked ? 'logging: blocked ' : 'logging: queued ') + pending);
      d.textContent = bits.join(' \u00b7 ');
      setBoxState();
      d.className = phase.cur === 'err' ? 'is-err' : (phase.cur === 'earn' || phase.cur === 'done') ? 'is-earn' : '';
    }
  }
  function setPhase(p) { phase.cur = p; renderStatus(); }
  function setDetail(t) { detailText = t || ''; renderStatus(); }
  function setStatus(t) { const el = $('az-phase'); if (el) { el.textContent = t; el.className = ''; } }
  function setSub() { }
  function renderSub() { renderStatus(); }
  function showPrimary(label, fn) { const b = $('az-primary'); if (!b) return; b.textContent = label; b.className = 'az-btn' + (label === 'Stop' ? ' is-stop' : ''); b.onclick = fn; }
  function markErr() { phase.cur = 'err'; renderStatus(); }
  function markIdle() { phase.cur = 'idle'; renderStatus(); }
  /* 400 lines is only a few seconds of a fast run, so the full view needs a
     deeper buffer to be worth having. */
  const LOG_MAX = 2000;
  let logBuf = [];
  let logMode = 0;
  /* 4th mode is the debugging one: every buffered line instead of the last 3,
     with the panel expanded. Useful when something looks wrong and the tail
     does not explain it. */
  const LOG_MODES = ['all', 'points', 'errors', 'full'];
  function logKind(line) {
    if (/bypass failed|error:|could not resolve|skip module/.test(line)) return 'is-err';
    if (/^\+[0-9,]+pt|^module .*\+|TARGET REACHED|final score|^== |^settled /.test(line)) return 'is-good';
    return '';
  }
  function stamp() { const d = new Date(); const p = n => String(n).padStart(2,'0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  const LOG_FULL = logMode === 3;
  function logVisible() {
    if (logMode === 1) return logBuf.filter(e => e.c === 'is-good').slice(-3);
    if (logMode === 2) return logBuf.filter(e => e.c === 'is-err').slice(-3);
    if (logMode === 3) return logBuf;
    return logBuf.slice(-3);
  }
  function renderLog() {
    const el = $('az-log'); if (!el) return;
    el.classList.toggle('is-full', logMode === 3);
    const rows = logVisible();
    /* esc() on both fields: a log line can carry remote text - the auto-pick
       line quotes an Education Perfect module name verbatim - and this is
       innerHTML. The one-line console below is the same data on screen at all
       times, so it gets the same treatment. */
    el.innerHTML = rows.length ? rows.map(e => '<div class="az-logrow ' + e.c + '"><span class="az-t">' + esc(e.t) + '</span><span class="az-m">' + esc(e.m) + '</span></div>').join('') : '<div class="az-logrow"><span class="az-t"></span><span class="az-m">no entries yet</span></div>';
    el.scrollTop = el.scrollHeight;
    azDockLine();
  }

  /* the newest log line, always on screen. textContent, never innerHTML. */
  function azDockLine() {
    const d = $('az-dockline');
    if (!d) return;
    const last = logBuf[logBuf.length - 1];
    d.textContent = last ? last.m : '';
    d.className = last ? last.c : '';
  }
  function setLogMode() {
    logMode = (logMode + 1) % LOG_MODES.length;
    const bx = $('az-chev');
    if (bx) { bx.dataset.mode = LOG_MODES[logMode]; const l = $('az-chev-l'); if (l) l.textContent = LOG_MODES[logMode]; }
    renderLog();
  }
  /* Copy the whole buffer out. 2,000 lines on screen is no use if the only
     way to read it is retyping a console snippet, which is exactly what
     debugging a broken browser otherwise turns into. */
  function logText() {
    return logBuf.map(e => e.t + '  ' + e.m).join('\n');
  }
  function vtCopyLog() {
    const text = logText();
    const note = (ok) => {
      const n = $('az-lognote');
      if (n) { n.textContent = ok ? 'copied ' + logBuf.length + ' lines' : 'copy failed — select the text instead'; setTimeout(() => { if (n) n.textContent = ''; }, 2200); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => note(true), () => note(false));
      return;
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      note(ok);
    } catch (e) { note(false); }
  }
  function setBoxState() {
    const box = $('az-box'); if (!box) return;
    box.classList.toggle('is-running', !!(running && phase.cur !== 'err' && phase.cur !== 'done'));
    box.classList.toggle('is-error', phase.cur === 'err');
    azDot();
  }
  function flashDetail() { const d = $('az-detail'); if (!d) return; d.classList.add('is-earn-flash'); setTimeout(() => d.classList.remove('is-earn-flash'), 700); }
  function log(line) {
    logBuf.push({ t: stamp(), m: line, c: logKind(line) });
    if (logBuf.length > LOG_MAX) logBuf = logBuf.slice(-LOG_MAX);
    renderLog();
    if (/^\+[0-9,]+pt/.test(line)) flashDetail();
  }
  let state = null, doneList = null, STORE = 'epMP', DONE_KEY = 'epMPdone', targetHit = false;
  const loadState = (u) => { const d = () => ({ lists: [], tally: { passes: 0, pts: 0, q: 0 }, lastScore: null }); try { const r = JSON.parse(localStorage.getItem(u) || 'null'); return r && typeof r === 'object' && !Array.isArray(r) ? Object.assign(d(), r, { tally: Object.assign({ passes: 0, pts: 0, q: 0 }, r.tally && typeof r.tally === 'object' ? r.tally : {}) }) : d(); } catch (_) { return d(); } };
  const saveState = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) { /* ignore */ } };
  const loadDone = (k) => { try { const r = JSON.parse(localStorage.getItem(k) || '[]'); return new Set(Array.isArray(r) ? r : []); } catch (_) { return new Set(); } };
  /* localStorage is user-writable, so every record read back is untrusted.
     Returns a usable {lists, ids, q} or null. `lists` is always derived from
     `ids` so it can never disagree with what doneFor() counts, which is what
     made a tampered record render as "?" in the module cards. */
  const normCounts = (c) => {
    if (!c || typeof c !== 'object' || !Array.isArray(c.ids)) return null;
    const ids = [];
    for (const x of c.ids) {
      let n = x;
      if (typeof x === 'string') { if (x.trim() === '') continue; n = Number(x); }
      else if (typeof x !== 'number') continue;
      if (Number.isFinite(n)) ids.push(n);
    }
    return { lists: ids.length, ids: ids, q: Number.isFinite(c.q) && c.q > 0 ? c.q : 0 };
  };
  let doneDirty = false, doneTimer = null;
  const saveDone = () => { doneDirty = true; };
  const flushDone = () => {
    if (!doneDirty) return;
    doneDirty = false;
    try { localStorage.setItem(DONE_KEY, JSON.stringify([...doneList])); } catch (_) { /* ignore */ }
  };
  const armDoneFlush = () => { if (!doneTimer) doneTimer = setInterval(flushDone, 1200); };

  async function scanModule(moduleId) {
    const rec = modCatalog.find(m => m.id === moduleId);
    const cached = rec && Array.isArray(rec.ids) ? rec.ids : (modCounts[moduleId] && modCounts[moduleId].ids);
    if (cached && cached.length) {
      scanModule.classic = new Set();
      return cached.slice();
    }
    const out = new Set();
    const classic = new Set();
    const variants = [
      { ActivityType: 0, ModuleID: moduleId, ModuleType: 1, FilterString: '', SkipCount: 0, TakeCount: 2000 },
      { ModuleID: moduleId, ModuleType: 1, FilterString: '', SkipCount: 0, TakeCount: 2000 }
    ];
    for (const params of variants) {
      const j = await A(NS + 'GetModuleActivitiesForBrowsingWithSchoolId', [params, ID.school]);
      const act = (j && j.result && j.result.Activities) || null;
      if (Array.isArray(act)) {
        for (const a of act) {
          const id = a.ID || a.ListID || a.ActivityID;
          if (!id) continue;
          const num = Number(id);
          if (a.ActivityType === 1) classic.add(num); else out.add(num);
        }
        if (out.size > 0) break;
      }
      await sleep(400);
    }
    scanModule.classic = classic;
    return [...out];
  }

  // prefetch structure AND attempt in parallel so workers only do save + store
  function makePrefetch(ids) {
    const cache = new Map();
    let i = 0;
    const loader = async () => {
      while (i < ids.length) {
        const id = ids[i++];
        if (cache.has(id)) continue;
        const p = (async () => {
          const st = await A(NS + 'GetStructuredActivityAndAttempts2WithSchoolId', [{ ActivityID: id, TaskID: urlTask || null }, ID.school], 30000);
          const act = st && st.result && st.result.Activity;
          if (!act) return { act: null, att: 0 };
          const map = {};
          const walk = n => { if (n.ContentIDs) for (const c of n.ContentIDs) map[c] = n.ID; if (n.Children) for (const c of n.Children) walk(c); };
          walk(act.Structure);
          if (!Object.keys(map).length) return { act, att: 0 };
          const sJ = await A(NS + 'StartNewActivityAttemptWithSchoolId', [id, urlTask || null, ID.school], 30000);
          const att = sJ && sJ.result && sJ.result.Attempt ? sJ.result.Attempt.ID : 0;
          return { act, att };
        })().catch(() => ({ act: null, att: 0 }));
        cache.set(id, p);
        await p;
      }
    };
    const pool = [];
    for (let k = 0; k < CFG.prefetch; k++) pool.push(loader());
    return cache;
  }

  const rampedTasks = new Set();
  async function freshBypass(listId, moduleId, taskId = 0, prefetched) {
    const us = await usList();
    let pre = prefetched;
    if (pre && typeof pre.then === 'function') pre = await pre;
    const preAct = pre && pre.act !== undefined ? pre.act : pre;
    const preAtt = pre && pre.att !== undefined ? pre.att : 0;
    let act = preAct;
    if (!act || act === null) {
      const isNull = act === null;
      if (!isNull) {
        const st = await A(NS + 'GetStructuredActivityAndAttempts2WithSchoolId', [{ ActivityID: listId, TaskID: taskId || null }, ID.school]);
        if (!st || st.err || !st.result) return { ok: false, n: 0 };
        if (!st.result.Activity) return { ok: false, n: 0, u: true };
        act = st.result.Activity;
      }
    }
    if (!act) return { ok: false, n: 0, u: true };
    const sub = act.BaseLanguage || ID.sub;
    const targ = act.TargetLanguage || ID.targ;
    const map = {};
    const walk = n => { if (n.ContentIDs) for (const c of n.ContentIDs) map[c] = n.ID; if (n.Children) for (const c of n.Children) walk(c); };
    walk(act.Structure);
    const ids = Object.keys(map).map(Number);
    if (!ids.length) return { ok: false, n: 0, u: true };
    const now = new Date().toISOString();
    let att = preAtt;
    if (!att) {
      const sJ = await A(NS + 'StartNewActivityAttemptWithSchoolId', [listId, taskId || null, ID.school]);
      if (!sJ || !sJ.result || !sJ.result.Attempt) return { ok: false, n: ids.length };
      att = sJ.result.Attempt.ID;
    }
    if (taskId && !rampedTasks.has(taskId)) {
      rampedTasks.add(taskId);
      const sr = await stealthRamp(taskId, moduleId, act.ID || listId);
      if (sr && !sr.skipped && !sr.err) log('stealth ' + sr.ok + '/' + sr.steps + ' frames');
      else if (sr && sr.skipped) log('stealth skip (task monitoring off)');
    }
    const saves = ids.map(id => ({
      AttemptID: att, ContentID: id, Section: map[id], ContentVersion: 0, TimeTaken: 1,
      DateLastUpdated: now, QuestionAttemptNumber: 1,
      UsersAnswer: JSON.stringify({ UserAnswer: { MultiChoice_1: [0] }, UserAnswerForMarkings: { MultiChoice_1: { marked: 1, score: 1, max: 1, weight: 1 } } }),
      UserState: null, Attempted: true, TranslationDirection: 5,
      QuestionState: JSON.stringify({ Variable: { a: 2, ans_MultiChoice_1: 'true' }, Component: { MultiChoice_1: [0, 0, 1, 0] } }),
      BasedOnAttemptNumber: null, DateStarted: now, MostRecentAnswer: true, Finalised: true,
      Grade: 1, ScoreFraction: 100, TimeTakenForReview: 0, SequenceNumber: 0,
      AnswerQualityTags: [], SeenByTeacherUserID: null
    }));
    const rows = ids.map(id => ({ TranslationID: id, TranslationDirection: 5, NewNumberRight: 1, NewNumberWrong: 0, NewData: CFG.NewData }));
    await A(NS + 'SaveFinalActivityAttemptAnswersWithSchoolId', [saves, ID.school]);
    const prog = await A(NS + 'StoreActivityProgress2', [us, {
      ActivityTypeId: 3, BaseLanguageId: sub, ClientTimezoneOffsetMinutes: 240, Data: rows,
      ListIds: [listId], RequestId: 'mp-' + Date.now() + '-' + rnd(100, 999),
      TargetLanguageId: targ, ModuleId: moduleId
    }]);
    return { ok: !!(prog && prog.result && prog.result.Success), n: ids.length };
  }

  async function gqlScore() {
    if (!ID.org) {
      try { for (const k of Object.keys(localStorage)) { if (k.indexOf('EP_SELECTED_SCHOOL_') === 0) { const v = localStorage.getItem(k); if (v && /^[0-9a-f-]{36}$/i.test(v)) { ID.org = v; break; } } } } catch (_) { /* ignore */ }
    }
    if (!ID.org) return null;
    const j = await gqlQ(`{ globalScoreboards { scoreboardScores(parameters: { organisationId: "${ID.org}", groupingType: GLOBAL, timeFrame: YEARLY }) { currentScore } } }`);
    const v = j && j.data && j.data.globalScoreboards && j.data.globalScoreboards.scoreboardScores && j.data.globalScoreboards.scoreboardScores.currentScore;
    return typeof v === 'number' ? v : null;
  }

  /* Poll until the scoreboard stops moving rather than reporting the last
     sampled read. Bounded at VT_SETTLE_POLLS so a flaky scoreboard can never
     make Stop appear to hang, and a null read breaks out and says so instead
     of reporting NaN. */
  const VT_TAIL_MS = 120000;   /* give up after two minutes */
  const VT_TAIL_EVERY = 2000; /* one read every two seconds */
  const VT_TAIL_QUIET = 4;    /* four still reads in a row and it is done */
  const VT_TAIL_MIN = 12000;  /* but never believe it sooner than this */
  let vtTailSeq = 0;

  function vtTailWatch() {
    const seq = ++vtTailSeq;
    let prev = state.lastScore, still = 0;
    const t0 = Date.now();
    (async function loop() {
      if (seq !== vtTailSeq) return;
      if (Date.now() - t0 > VT_TAIL_MS) return;
      await sleep(VT_TAIL_EVERY);
      if (seq !== vtTailSeq) return;              /* a new run took over */
      const s2 = await gqlScore();
      if (seq !== vtTailSeq) return;
      if (s2 !== null && s2 !== prev) {
        const d = s2 - (prev === null || prev === undefined ? s2 : prev);
        still = 0;
        phase.score = s2; state.lastScore = s2;
        if (d > 0) { phase.lastDelta = d; }
        renderStatus();
        log('late credit +' + sc(d) + 'pt at +' + Math.round((Date.now() - t0) / 1000) + 's · score now ' + sc(s2), 'is-good');
        prev = s2;
      } else if (s2 !== null) still++;
      if (s2 !== null) prev = s2;
      renderLog();
      if (still >= VT_TAIL_QUIET && Date.now() - t0 >= VT_TAIL_MIN) return;
      loop();
    })();
  }

  async function vtSettleScore(reason) {
    /* nothing was written, so there is nothing to wait for - a cancel during
       the module scan must not cost the user two seconds */
    if (!state || !state.tally || !state.tally.passes) return { gained: 0, late: 0, polls: 0, skipped: true };
    let prev = state.lastScore, stable = 0, late = 0, polls = 0;
    for (let i = 0; i < VT_SETTLE_POLLS && (stable < VT_SETTLE_STABLE || polls < VT_SETTLE_MIN); i++) {
      polls++;
      await sleep(VT_SETTLE_EVERY);
      const s = await gqlScore();
      if (s === null) { log('settle: scoreboard unreachable - reporting last verified ' + sc(prev)); break; }
      if (s !== prev) { stable = 0; if (prev !== null && prev !== undefined) late += s - prev; }
      else stable++;
      prev = s;
      state.lastScore = s; phase.score = s;
    }
    const gained = (prev !== null && prev !== undefined && state.grade0 !== null && state.grade0 !== undefined)
      ? prev - state.grade0 : 0;
    return { gained, late, polls, skipped: false };
  }

  async function stealthRamp(TASK, mod, ACTIVITY) {
    try {
      const sid = ID.session || (await usList());
      if (!sid) return { skipped: true };
      const pol = await A(NS + 'GetTaskMonitoringStatus', [sid, TASK]);
      const p = pol && pol.result && pol.result.Status;
      if (!p || !(p.TrackStudentFocus || p.EnableLiveActivityFeed)) return { skipped: true };
      const end = Date.now() - rnd(800, 1500);
      const winMs = Math.min(8 * 10 * 1000, 480 * 1000) - 1000;
      const startMs = end - winMs;
      const steps = 6;
      let ok = 0;
      for (let i = 1; i <= steps; i++) {
        const j = await A(NS + 'SubmitTaskMonitoringStatus', [{
          SessionID: sid, TaskID: TASK, Events: [], StatusUpdate: {
            ModuleID: mod, ActivityID: ACTIVITY,
            FocusStatus: 1, FullScreenStatus: p.RequireFullScreenMode ? 1 : 0,
            ActiveStatus: 1, IsInGame: false,
            UpdateDateTime: new Date(startMs + Math.floor((winMs / steps) * (i - 1)) + rnd(0, 500)).toISOString(),
            PercentComplete: i / steps
          }
        }]);
        if (j && j.result && j.result.Success) ok++;
        await sleep(rnd(60, 160));
      }
      return { ok, steps };
    } catch (_) { return { err: true }; }
  }

  function fmtScore(sc, target) { return sc == null ? '—' : sc.toLocaleString('en-US') + (target ? ' / ' + target.toLocaleString('en-US') : ''); }

  // ---- module picker --------------------------------------------------------
  const MOD_KEY = 'epMPmods:', CT_KEY = 'epMPct:', ES_KEY = 'epMPest:';
  let modSel = new Set(), modCatalog = [], modCounts = {}, modEstCache = {}, pickerReady = false;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } };
  const loadModSel = () => { try { const r = JSON.parse(lsGet(MOD_KEY + (ID.user || 'anon')) || '[]'); return new Set(Array.isArray(r) ? r.filter(x => Number.isFinite(Number(x))).map(Number) : []); } catch (_) { return new Set(); } };
  const saveModSel = () => lsSet(MOD_KEY + (ID.user || 'anon'), JSON.stringify([...modSel]));
  const modKey = (id) => id + '@' + (ID.user || 'anon');

  async function loadModuleCounts(target) {
    try {
      let i = 0;
      const workerFn = async () => {
        while (i < target.length) {
          const idx = i++;
          if (idx >= target.length) break;
          const id = target[idx];
          const rec = modCatalog.find(m => m.id === id);
          const fromMap = rec && Array.isArray(rec.ids) && rec.ids.length;
          if (modCounts[id]) {
            if (fromMap && !modCounts[id].q) modCounts[id].q = rec.avgQ || 0;
            updateCard(id); continue;
          }
          if (fromMap) {
            modCounts[id] = normCounts({ ids: rec.ids, q: rec.avgQ || 0 });
            lsSet(CT_KEY + modKey(id), JSON.stringify(modCounts[id]));
            updateCard(id); continue;
          }
          const ck = CT_KEY + modKey(id);
          const cached = lsGet(ck);
          if (cached) { try { const c = normCounts(JSON.parse(cached)); if (c) { modCounts[id] = c; updateCard(id); continue; } } catch (_) { /* bad cache, fall through to a rescan */ } try { localStorage.removeItem(ck); } catch (_) { /* ignore */ } }
          const j = await A(NS + 'GetModuleActivitiesForBrowsingWithSchoolId', [{ ActivityType: 0, ModuleID: id, ModuleType: 1, FilterString: '', SkipCount: 0, TakeCount: 2000 }, ID.school], 30000);
          const acts = (j && j.result && j.result.Activities) || [];
          const ids = [...new Set(acts.filter(a => a.ActivityType === 5).map(a => a.ID).filter(Boolean))];
          const undone = ids.filter(x => !doneList.has(x));
          let sample = 0;
          for (const x of undone.slice(0, 3)) {
            const st = await A(NS + 'GetStructuredActivityAndAttempts2WithSchoolId', [{ ActivityID: x, TaskID: null }, ID.school], 15000);
            const act = st && st.result && st.result.Activity;
            if (!act) continue;
            const ids2 = {};
            const walk = n => { if (n.ContentIDs) for (const c of n.ContentIDs) ids2[c] = 1; if (n.Children) for (const c of n.Children) walk(c); };
            walk(act.Structure || {});
            sample = Math.max(sample, Object.keys(ids2).length);
            if (sample > 0) break;
          }
          modCounts[id] = normCounts({ ids: ids, q: sample });
          lsSet(ck, JSON.stringify(modCounts[id]));
          updateCard(id);
        }
      };
      const pool = [];
      for (let k = 0; k < 6; k++) pool.push(workerFn());
      await Promise.all(pool);
    } catch (_) { /* counts best-effort */ }
  }

  async function ensureIdentity() {
    if (!ID.user) await resolveIdentity();
    if (!running) doneList = loadDone('epMPdone:' + (ID.user || 'anon'));
  }

  /* null only when there are no counts for this module yet ("scanning").
     every record reaching modCounts went through normCounts, so ids is
     always an array and the count is always a number. */
  function doneFor(c) {
    if (!c || !Array.isArray(c.ids)) return null;
    let n = 0;
    for (const x of c.ids) if (doneList.has(x)) n++;
    return n;
  }
  function ptsLeft(c) {
    if (!c || !c.lists) return 0;
    const dn = doneFor(c) || 0;
    const left = Math.max(0, c.lists - dn);
    const q = c.q || 0;
    return q ? Math.round(left * q * PT_PER_Q) : 0;
  }
  /* A 3-list probe is a SAMPLE. Only a probe that covered every structured
     list is a census, and only a census may zero out a module. Applying a
     sample ratio to the whole module flagged untouched catalogs (0/848) as
     exhausted and zeroed their point estimate. */
  function modCensus(m) {
    if (!m || typeof m.structured !== 'number' || m.structured <= 0) return false;
    return typeof m.probed === 'number' && m.probed >= m.structured;
  }
  function modRatio(m) {
    if (!modCensus(m)) return 1;
    return m.freshRatio === undefined ? 1 : m.freshRatio;
  }
  function modulePts(m, c) {
    const total = (c && c.lists) || m.structured || 0;
    if (!total) return 0;
    const dn = doneFor(c) || 0;
    const left = Math.max(0, total - dn);
    const q = (c && c.q) || m.avgQ || 0;
    return q ? Math.round(left * q * PT_PER_Q * modRatio(m)) : 0;
  }
  function modExhausted(m, c) {
    if (!m) return false;
    const total = (c && c.lists) || m.structured || 0;
    const dn = doneFor(c);
    if (total > 0 && dn !== null && dn >= total) return true;
    return modCensus(m) && m.freshRatio === 0 && m.attemptedLists > 0;
  }
  const fmtPts = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
  function updateCard(id) {
    const card = document.querySelector('.az-card[data-id="' + id + '"]');
    if (!card) return;
    const c = modCounts[id];
    const dn = doneFor(c);
    const total = (c && c.lists) || 0;
    const isDone = !!(total > 0 && dn !== null && dn >= total);
    const pct = total ? Math.round(100 * (dn || 0) / total) : 0;
    card.classList.toggle('complete', isDone);
    const chk = card.querySelector('.az-check');
    if (chk) chk.disabled = !!isDone;
    const meta = card.querySelector('.az-card-meta');
    if (meta) {
      const m = modCatalog.find(x => x.id === id);
      let t = c ? '<b>' + (dn || 0) + '/' + total + '</b> lists' : 'scanning…';
      const pl = m ? modulePts(m, c) : ptsLeft(c);
      const dead = isDone || modExhausted(m, c);
      if (dead) t += ' · <b style="color:var(--err)">exhausted</b>';
      else if (pl > 0) t += ' · ≈ <b>' + fmtPts(pl) + 'pt</b> left';
      if (m && modCensus(m) && m.freshRatio < 0.7 && !dead && pl > 0) t += ' · <span style="color:var(--acc)">partly credited</span>';
      if (pct > 0 && !dead) t += ' · ' + pct + '%';
      meta.innerHTML = t;
    }
    renderSelCount();
  }

  function cardHTML(m) {
    const id = m.id;
    const c = modCounts[id];
    const dn = doneFor(c);
    const total = (c && c.lists) || 0;
    const isDone = !!(total > 0 && dn !== null && dn >= total);
    let meta;
    if (c) meta = '<b>' + (dn || 0) + '/' + total + '</b> lists';
    else if (m.lists) meta = '<b>' + m.structured + '</b>/' + m.lists + ' lists';
    else meta = 'scanning…';
    const pl = modulePts(m, c);
    const dead = modExhausted(m, c);
    if (dead) meta += ' · <b style="color:var(--err)">exhausted</b>';
    else if (pl > 0) meta += ' · ≈ <b>' + fmtPts(pl) + 'pt</b> left';
    if (modCensus(m) && m.freshRatio < 0.7 && !dead && pl > 0) meta += ' · <span style="color:var(--acc)">partly credited</span>';
    if (m.classic > 0) meta += ' · <span style="color:var(--err)">' + m.classic + ' nocredit</span>';
    return '<label class="az-card' + (isDone ? ' complete' : '') + '" data-id="' + id + '">'
      + '<input type="checkbox" class="az-check" data-id="' + id + '"' + (modSel.has(id) ? ' checked' : '') + (isDone ? ' disabled' : '') + '>'
      + '<span class="az-card-body">'
      + '<span class="az-card-name">' + esc(m.name) + (isDone ? '<span class="az-card-complete-chip">COMPLETE</span>' : '') + '</span>'
      + '<span class="az-card-tags"><span class="az-tag' + (m.official ? ' official' : '') + '">' + esc(m.subject) + '</span>'
      + (m.official ? '<span class="az-tag official">official</span>' : m.personal ? '<span class="az-tag">personal</span>' : '<span class="az-tag">built-in</span>') + '</span>'
      + '<div class="az-card-meta">' + meta + '</div>'
      + '</span></label>';
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function modIsComplete(m) {
    const c = modCounts[m.id];
    return !!(c && c.lists > 0 && (doneFor(c) || 0) >= c.lists);
  }
  function renderGrid() {
    const grid = $('az-modgrid');
    if (!grid) return;
    const q = ($('az-search').value || '').trim().toLowerCase();
    const list = modCatalog.filter(m => !q || (m.name + ' ' + m.subject).toLowerCase().includes(q));
    if (!pickerReady) {
      /* the map loader overlay is inset:0 over the grid and opaque, so it
         doubles as the discovering spinner instead of bare text. renderGrid
         owns both directions, because the cached-map path returns without ever
         calling hideMapLoader and would otherwise leave the overlay covering
         the cards. */
      grid.innerHTML = '';
      showMapLoader('discovering modules');
      renderSelCount();
      return;
    }
    hideMapLoader();
    list.sort((a, b) => {
      const ca = modIsComplete(a) ? 1 : 0, cb = modIsComplete(b) ? 1 : 0;
      if (ca !== cb) return cb - ca;
      const est = (m) => { const c = modCounts[m.id]; const left = c && c.lists ? Math.max(0, c.lists - (doneFor(c) || 0)) : (m.estimated || 0); return left; };
      return est(b) - est(a);
    });
    grid.innerHTML = list.map(cardHTML).join('') || '<div class="az-card-meta" style="padding:16px;text-align:center">no modules</div>';
    renderSelCount();
  }

  function renderSelCount() {
    const el = $('az-selcount');
    if (el) el.textContent = pickerReady ? (modSel.size + ' selected') : 'loading…';
  }

  function setPickerReady(on) {
    pickerReady = !!on;
    for (const id of ['az-selall', 'az-selnone', 'az-search', 'az-remap']) { const el = $(id); if (el) el.disabled = !pickerReady; }
  }

  let pickerLoadSeq = 0;
  async function openPicker() {
    const seq = ++pickerLoadSeq;
    const modal = $('az-picker');
    if (modal) { modal.classList.remove('hidden'); modal.classList.remove('is-closing'); }
    azPlace('picker', document.querySelector('.az-modal'), 760, 400);
    $('az-gridstate').textContent = 'discovering…';
    setPickerReady(false);
    renderGrid();
    await ensureIdentity();
    if (seq !== pickerLoadSeq) return;
    modSel = loadModSel();
    const cached = loadMap();
    if (cached && cached.length) {
      modCatalog = cached;
      setPickerReady(true); hydrateCounts(); renderGrid();
      const haveIds = modCatalog.filter(m => Array.isArray(m.ids) && m.ids.length).length;
      $('az-gridstate').textContent = modCatalog.length + ' modules · ' + (haveIds || 0) + ' mapped';
      if (running || haveIds === modCatalog.length) return;
      loadModuleCounts(modCatalog.filter(m => !(m.ids && m.ids.length)).map(m => m.id));
      return;
    }
    if (modCatalog.length) { setPickerReady(true); hydrateCounts(); renderGrid(); }
    else {
      const found = await discoverModules();
      if (seq !== pickerLoadSeq) return;
      showMapLoader();
      $('az-gridstate').textContent = 'remapping…';
      const totalMods = found.length;
      setMapCount(0, totalMods);
      const mapped = await buildMap(found, (d, t) => setMapCount(d, t));
      if (seq !== pickerLoadSeq) return;
      modCatalog = mapped.length ? mapped : found.slice().sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      lsSet(MAP_KEY + (ID.user || 'anon'), JSON.stringify(modCatalog));
      hideMapLoader();
      setPickerReady(true);
      hydrateCounts();
      renderGrid();
    }
    if (running) { $('az-gridstate').textContent = 'counts load after run'; return; }
    $('az-gridstate').textContent = modCatalog.length + ' modules';
  }

  function hydrateCounts() {
    const drop = (k) => { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } };
    for (const m of modCatalog) {
      const ck = CT_KEY + modKey(m.id);
      let c = null;
      try { c = normCounts(JSON.parse(lsGet(ck))); } catch (_) { c = null; }
      if (c) modCounts[m.id] = c; else drop(ck);
      const ek = ES_KEY + modKey(m.id);
      const e = parseInt(lsGet(ek), 10);
      if (e > 0) modEstCache[m.id] = { est: e }; else drop(ek);
    }
    for (const m of modCatalog) {
      if (!modCounts[m.id] && Array.isArray(m.ids)) modCounts[m.id] = normCounts({ ids: m.ids, q: m.avgQ || 0 });
      if (m.avgQ && modCounts[m.id] && !modCounts[m.id].q) modCounts[m.id].q = m.avgQ;
    }
  }

  let mapDotsTimer = null, mapDone = null;
  function stopDots() {
    if (mapDotsTimer) { clearInterval(mapDotsTimer); mapDotsTimer = null; }
    const d = $('az-mapdots');
    if (d) d.textContent = '';
    if (mapDone) { mapDone(); mapDone = null; }
  }
  function startDots() {
    const d = $('az-mapdots');
    if (!d) return;
    let n = 0;
    d.textContent = '.';
    if (mapDotsTimer) clearInterval(mapDotsTimer);
    mapDotsTimer = setInterval(() => { n = (n + 1) % 4; d.textContent = '.'.repeat(n); }, 420);
  }
  function setMapCount(done, total) {
    const c = $('az-mapcount');
    if (!c) return;
    c.textContent = total ? done + ' / ' + total + ' modules' : '';
  }
  function showMapLoader(label) {
    const l = $('az-mapload'), n = $('az-mapnote');
    if (l) {
      l.classList.add('is-on');
      const t = $('az-maptext');
      if (t) t.textContent = label || 'remapping modules';
    }
    if (n) { n.style.display = 'none'; n.textContent = ''; }
    setMapCount(0, 0);
    startDots();
    setPickerReady(false);
  }
  function hideMapLoader() {
    const l = $('az-mapload');
    if (l) l.classList.remove('is-on');
    stopDots();
  }
  /* reduced motion gets the old instant behaviour rather than a wait */
  function closePicker() {
    const p = $('az-picker');
    if (!p || p.classList.contains('hidden')) return;
    const modal = p.querySelector('.az-modal');
    const still = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      || !(modal && typeof modal.getAnimations === 'function');
    if (still) { p.classList.add('hidden'); p.classList.remove('is-closing'); return; }
    p.classList.add('is-closing');
    const seq = pickerLoadSeq;
    const done = () => {
      /* reopened mid-fade: this close no longer owns the picker */
      if (seq !== pickerLoadSeq) return;
      p.classList.add('hidden'); p.classList.remove('is-closing');
    };
    const anims = modal.getAnimations();
    if (anims.length) Promise.all(anims.map(a => a.finished.catch(() => {}))).then(done, done);
    /* backstop: waiting on animations alone can wedge the picker shut forever.
       getAnimations() can hand back something that never settles - a replaced or
       paused animation - and then Promise.all never resolves, is-closing stays
       set, and the window neither hides nor recovers. done is idempotent, so the
       timer is armed unconditionally and whichever arrives first wins. */
    setTimeout(done, 240);
  }

  function wirePicker() {
    const menu = $('az-menu');
    if (!menu || menu.dataset.wired) return;
    menu.dataset.wired = '1';
    menu.onclick = openPicker;
    $('az-close').onclick = closePicker;
    const pmin = $('az-pmin');
    if (pmin) pmin.onclick = () => azToggleMin(document.querySelector('.az-modal'), pmin);
    const phead = $('az-phead');
    if (phead) azDraggable(document.querySelector('.az-modal'), phead, 'picker');
    $('az-search').oninput = renderGrid;
    /* only select modules that can actually be farmed. Completed modules render
       a disabled checkbox, so including their ids made "select all" look like
       it had ticked them when the control would not accept the tick. */
    $('az-selall').onclick = () => {
      modSel = new Set(modCatalog.filter(m => !modIsComplete(m)).map(m => m.id));
      saveModSel();
      renderGrid();
    };
    $('az-selnone').onclick = () => { modSel = new Set(); saveModSel(); renderGrid(); };
    $('az-remap').onclick = async () => {
      if (running) { $('az-gridstate').textContent = 'stop the run first'; return; }
      showMapLoader();
      $('az-gridstate').textContent = 'remapping…';
      const prev = modCatalog;
      try {
        const found = prev.length ? prev : await discoverModules();
        setMapCount(0, found.length);
        const mapped = await buildMap(found, (d, t) => setMapCount(d, t));
        modCatalog = mapped.length ? mapped : found;
        lsSet(MAP_KEY + (ID.user || 'anon'), JSON.stringify(modCatalog));
        hideMapLoader();
        setPickerReady(true);
        hydrateCounts();
        /* Remap rebuilds the catalogue, so the old selection can point at ids
           that no longer exist. Keep whatever survived and say what was lost,
           rather than silently ticking nothing. */
        const alive = new Set(modCatalog.map(m => m.id));
        const keptIds = [...modSel].filter(id => alive.has(id));
        const dropped = modSel.size - keptIds.length;
        modSel = new Set(keptIds);
        saveModSel();
        renderGrid();
        $('az-gridstate').textContent = modCatalog.length + ' modules (remapped)';
        log('remapped ' + modCatalog.length + ' modules'
          + (dropped ? ' — dropped ' + dropped + ' selected module(s) that are gone' : '')
          + (keptIds.length ? ' — kept ' + keptIds.length + ' ticked' : ''));
      } catch (e) {
        const n = $('az-mapnote');
        if (n) { n.textContent = 'remap failed — keeping the previous map'; n.style.display = 'block'; }
        const lb = $('az-mapload') && $('az-mapload').querySelector('.az-maplabel');
        if (lb) lb.textContent = 'remap failed';
        log('remap failed — keeping the previous module map');
        setTimeout(() => {
          hideMapLoader();
          setPickerReady(true);
          renderGrid();
          $('az-gridstate').textContent = modCatalog.length + ' modules (previous map kept)';
        }, 2400);
      }
    };
    $('az-modgrid').addEventListener('change', (e) => {
      if (!e.target.classList.contains('az-check')) return;
      const id = Number(e.target.getAttribute('data-id'));
      if (e.target.checked) modSel.add(id); else modSel.delete(id);
      saveModSel();
      renderSelCount();
    });
  }

  async function run() {
    let settleGuard = false;   /* the settle polls; it must not run twice */
    if (running) return null;
    running = true; targetHit = false;
    phase.cur = 'run'; phase.lastDelta = 0; phase.rate = 0; phase.doneTotal = 0;
    renderStatus(); startTimer();
    showPrimary('Stop', () => { running = false; setStatus('stopping…'); });
    logBuf = []; log('== Verity ==');
    /* watch the gate + denylist for as long as this run is live */
    vtWatchStart();

    await resolveIdentity();
    if (!ID.user || !ID.school) { markErr(); setStatusText('session expired — log back into EP'); log('error: could not resolve identity (401?) — log back into educationperfect.com'); vtLogDone({ ok: false, reason: 'identity failed — session expired' }); stopExit(true); return { ok: false, error: 'identity' }; }
    const pm = pageModule();
    const baseMods = [...new Set([...MODULES, pm].filter(Boolean))];
    if (!$('#az-menu')) wirePicker();
    let discovered = loadMap();
    if (!discovered || !discovered.length) {
      log('discovering modules…');
      discovered = await discoverModules();
    }
    modCatalog = discovered;
    const selMods = loadModSel();
    modSel = selMods;
    const allIds = [...new Set([...baseMods, ...discovered.map(d => d.id)])];
    const byId = Object.fromEntries(discovered.map(d => [d.id, d]));
    STORE = 'epMP:' + (ID.user || 'anon');
    DONE_KEY = 'epMPdone:' + (ID.user || 'anon');
    state = loadState(STORE);
    doneList = loadDone(DONE_KEY);
    phase.doneTotal = doneList.size;
    for (const d of discovered) {
      if (Array.isArray(d.ids) && d.ids.length) {
        modCounts[d.id] = normCounts({ ids: d.ids, q: d.avgQ || 0 });
      }
    }
    const ptsOf = (id) => { const m = byId[id]; if (!m) return 0; const c = modCounts[id]; const total = m.structured || 0; if (!total) return 0; const dn = doneFor(c) || 0; const q = m.avgQ || (c && c.q) || 0; return Math.round(Math.max(0, total - dn) * q * PT_PER_Q * modRatio(m)); };
    const mapped = (id) => byId[id] && Array.isArray(byId[id].ids) && byId[id].ids.length;
    const exhausted = (id) => modExhausted(byId[id], modCounts[id]);
    /* only a KNOWN empty module counts. A freshly discovered module has no
       `structured` key at all, and `!undefined` is true, so treating unknown
       as empty made auto-pick reject every module on a first run. */
    const noStruct = (id) => { const m = byId[id]; return !!(m && typeof m.structured === 'number' && m.structured <= 0); };
    const picked = selMods.size ? allIds.filter(id => selMods.has(id)) : [];
    const mods = [];
    let skippedDry = 0, skippedEmpty = 0;
    for (const id of picked) {
      if (mapped(id) && noStruct(id)) { log('skip module ' + id + ' — ' + ((byId[id] && byId[id].classic) || 0) + ' classic lists, no creditable content'); skippedEmpty++; continue; }
      if (mapped(id) && exhausted(id)) { log('skip module ' + id + ' — fully credited, nothing to gain'); skippedDry++; continue; }
      mods.push(id);
    }
    if (skippedDry) log('skipped ' + skippedDry + ' exhausted module(s) (no fresh questions left)');
    if (skippedEmpty) log('skipped ' + skippedEmpty + ' module(s) with no structured content');
    mods.sort((a, b) => ptsOf(b) - ptsOf(a));
    if (!mods.length) {
      /* Auto-pick must not require mapped(): on a first run the map has no ids
         yet (discoverModules returns ids: []), so requiring mapped() meant
         nothing was ever selectable until the user opened the picker once.
         A module with no ids still runs - scanModule fetches them live. */
      const best = allIds.filter(id => byId[id] && !noStruct(id) && !exhausted(id))
        .sort((a, b) => ptsOf(b) - ptsOf(a))[0];
      if (best) {
        log('nothing in the current selection — auto-picking the best module left');
        mods.push(best);
        log('auto-picked module ' + best + ' (' + ((byId[best] && byId[best].name) || '') + ' · ≈' + ptsOf(best) + 'pt left)');
      }
    }
    phase.modsTotal = mods.length;
    if (!mods.length) {
      const anyDiscovered = Object.keys(byId).length > 0;
      const why = selMods.size
        ? 'nothing left to farm in the selected modules — pick fresher ones in ☰'
        : (anyDiscovered
          ? 'no module has any farmable content — open ☰ and run remap'
          : 'module list is empty — open ☰ once so it can build, then Start works on its own');
      markErr(); setStatusText('nothing to farm'); log(why); vtLogDone({ ok: false, reason: 'nothing to farm — ' + why }); stopExit(true);
      return { ok: false, error: why };
    }
    renderSub();

    const us = await usList();
    armDoneFlush();
    log('identity: user=' + ID.user + ' type=' + ID.type + ' school=' + ID.school + ' us=' + us + ' org=' + (ID.org || '?'));
    if (!ID.school || !ID.user) { markErr(); setStatusText('identity failed'); log('error: could not resolve identity — run while logged into EP'); stopExit(true); return { ok: false, error: 'identity' }; }

    const target = 0;
    phase.target = target;
    state.lastScore = await gqlScore();
    if (state.lastScore === null) state.lastScore = phase.score;
    /* a run that starts supersedes any watcher still reading from the last one */
    vtTailSeq++;
    /* the hero reads phase.score, and the first verify tick is eight lists away.
       Publishing the opening read here means the number is up before the first
       bypass rather than after the first checkpoint. */
    if (state.lastScore !== null && state.lastScore !== undefined) phase.score = state.lastScore;
    state.grade0 = state.lastScore;
    VT_LOG.started = Date.now();
    VT_LOG.done = false;
    VT_LOG.runLists = 0;
    VT_LOG.runMods = 0;
    VT_LOG.maxRate = 0;
    VT_LOG.errors = [];
    VT_LOG.mods = [];
    VT_LOG.startScore = state.lastScore;
    VT_LOG.saidRun = false;
    VT_LOG.announced = false;
    VT_LOG.target = phase.target || 0;
    VT_LOG.picked = phase.modsTotal || 0;
    vtLogRun();
    phase.score = state.lastScore;
    log('score: ' + fmtScore(state.lastScore, target) + (target ? '  stopAt=' + target : '  stopAt=off'));
    if (target && state.lastScore != null && state.lastScore >= target) {
      log('score already ' + state.lastScore + ' >= target ' + target + ' — raise the target or clear the box to sweep anyway');
      setPhase('done');
      stopExit();
      return { ok: false, error: 'target already met', score: state.lastScore };
    }
    setPhase('ready');
    saveState();

    try {
      for (const MODULE of mods) {
        if (!running) break;
        if (target && !targetHit) {
          const s = await gqlScore();
          if (s !== null) {
            state.lastScore = s; phase.score = s;
            if (s >= target) {
              targetHit = true;
              log('target met ' + s + ' >= ' + target + ' — stopping before ' + MODULE);
              running = false;
              break;
            }
          }
        }
        log('-- module ' + MODULE + ' --');
        phase.mod = MODULE; phase.list = 0; phase.cur = 'scan';
        renderStatus();
        const listIds = await scanModule(MODULE);
        const classicSet = scanModule.classic || new Set();
        const classicCount = listIds.filter(id => classicSet.has(id)).length;
        log('scanned ' + listIds.length + ' lists (' + classicCount + ' classic), knownDone=' + doneList.size);
        const todo = listIds.filter(id => !doneList.has(id) && !classicSet.has(id));
        if (classicCount) for (const id of listIds) if (classicSet.has(id)) doneList.add(id);
        flushDone();
        const prefetch = makePrefetch(todo);
        phase.total = todo.length; phase.list = 0;
        let idx = 0, tick = 0, lastEarnTick = 0, moduleEarned = false, failBurst = 0, dryStreak = 0, drySince = 0, moduleDry = false, modProcessed = 0, modUnsupported = classicCount, modPts = 0;
        const claimVerify = () => { tick++; return tick % CFG.verifyEvery === 0 ? tick : 0; };
        const worker = async () => {
          while (running) {
            if (idx >= todo.length) { break; }
            const lid = todo[idx]; idx++; phase.list = idx;
            doneList.add(lid); saveDone(); phase.doneTotal = doneList.size; renderSub();
            phase.cur = 'run'; renderStatus();
            const r = await freshBypass(lid, MODULE, urlTask, prefetch.get(lid));
            modProcessed++;
            if (r.u) modUnsupported++;
            if ((modProcessed & 63) === 0) updateCard(MODULE);
            if (failBurst >= 3) { await sleep(900); failBurst = 0; }
            const vt = claimVerify();
            if (!vt) {
              if (r.ok) {
                failBurst = 0;
                state.tally.passes++;
                state.tally.q = (state.tally.q || 0) + r.n;
                phase.rate = (state.tally.q / (Math.max((Date.now() - (markStart || Date.now())) / 1000, 1))).toFixed(0);
              } else if (!r.u) { failBurst++; }
              await sleep(CFG.spacing);
              continue;
            }
            const before = phase.score;
            await sleep(CFG.scoreWait);
            let sc = await gqlScore();
            if (sc !== null && before !== null && sc > before) { /* moved — no re-read needed */ }
            else if (sc !== null) { await sleep(800); const sc2 = await gqlScore(); if (sc2 !== null && sc2 > sc) sc = sc2; }
            if (sc === null) { log('score check skipped on ' + lid); }
            else {
              const prev = phase.score;
              const delta = (prev !== null && prev !== undefined) ? (sc - prev) : 0;
              phase.score = sc; phase.lastDelta = delta;
              state.lastScore = sc;
              if (delta > 0) modPts += delta;
              if (r.ok) {
                if (delta > 0) { moduleEarned = true; dryStreak = 0; drySince = 0; }
                else { dryStreak++; if (dryStreak === 1) drySince = Date.now(); }
                failBurst = 0;
                state.tally.passes++;
                state.tally.q = (state.tally.q || 0) + r.n;
                phase.rate = (state.tally.q / (Math.max((Date.now() - (markStart || Date.now())) / 1000, 1))).toFixed(0);
                if (Number(phase.rate) > (VT_LOG.maxRate || 0)) VT_LOG.maxRate = Number(phase.rate);
                if (delta > 0) {
                  const since = vt - lastEarnTick;
                  lastEarnTick = vt;
                  log('+' + delta + 'pt  [' + lid + ' ' + r.n + 'q]  score=' + sc + (target ? '/' + target : '') + (since > 1 ? '  (≈' + since + ' lists)' : '') + '  ' + phase.rate + 'Qt/s');
                }
                saveState();
                phase.cur = delta > 0 ? 'earn' : 'run'; renderStatus();
              } else if (!r.u) { failBurst++; phase.cur = 'err'; vtErr('bypass failed [' + lid + ']'); log('bypass failed [' + lid + '] score=' + sc); renderStatus(); }
            }
            if (sc !== null && !moduleDry && !moduleEarned && dryStreak >= CFG.dryStreak && drySince && (Date.now() - drySince) >= CFG.dryWindow) {
              await sleep(3000);
              let scF = await gqlScore();
              if (scF !== null) { await sleep(2500); const scF2 = await gqlScore(); if (scF2 !== null && scF2 > scF) scF = scF2; }
              if (scF === null) log('dry settle: scoreboard gone — holding, not abandoning');
              else if (phase.score !== null && scF <= phase.score) {
                moduleDry = true;
                log('module ' + MODULE + ' dry (' + dryStreak + ' flats over ' + fmtMs(Date.now() - drySince) + ') — abandoning remainder');
                saveState();
                break;
              } else {
                const late = phase.score === null ? 0 : (scF - phase.score);
                phase.score = scF; state.lastScore = scF; phase.lastDelta = late;
                if (late > 0) { modPts += late; moduleEarned = true; }
                dryStreak = 0; drySince = 0;
                log('late credit landed +' + late + 'pt on ' + lid + ' — continuing');
                saveState();
              }
            }
            if (target && !targetHit && state.lastScore !== null && state.lastScore >= target) {
              targetHit = true;
              log('TARGET REACHED ' + state.lastScore);
              running = false;
              break;
            }
            await sleep(CFG.spacing);
          }
        };
        const workers = [];
        for (let w = 0; w < CFG.workers; w++) workers.push(worker());
        await Promise.all(workers);
        VT_LOG.runLists += modProcessed;
        VT_LOG.runMods += 1;
        { const _rec = (byId && byId[MODULE]) ? byId[MODULE] : null; VT_LOG.mods.push({ id: MODULE, name: _rec ? _rec.name : '', lists: modProcessed, pts: modPts, unsup: modUnsupported, dry: !!moduleDry }); }
        if (moduleDry) {
          for (let k = idx; k < todo.length; k++) { doneList.add(todo[k]); }
          saveDone();
          log('module ' + MODULE + ' · ' + modProcessed + ' lists processed · +' + modPts + 'pt · ' + modUnsupported + ' unsupported · ' + (todo.length - idx) + ' marked done (dry)');
        } else {
          log('module ' + MODULE + ' · ' + modProcessed + ' lists processed · +' + modPts + 'pt · ' + modUnsupported + ' unsupported' + (!moduleEarned ? ' · flat' : ''));
        }
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      markErr();
      vtErr('error: ' + msg);
      log('error: ' + msg);
      if (!settleGuard && state && state.tally && state.tally.passes) {
        settleGuard = true;
        const s2 = await vtSettleScore('fatal');
        vtTailWatch();
        log('settled +' + sc(s2.gained) + 'pt before the error report');
        vtLogDone({ ok: false, reason: 'fatal: ' + msg, pts: s2.gained });
      } else {
        vtLogDone({ ok: false, reason: 'fatal: ' + msg });
      }
      stopExit(true);
      return { ok: false, error: msg };
    }
    const finalTarget = 0;
    if (settleGuard) return { ok: false, error: 'already settled' };
    settleGuard = true;
    /* "settling…" told the user nothing they could not already see - the phase
     line above it already reads SETTLE. What is actually happening is that EP
     posts points late, so the number on screen is not final yet. Say that. */
   phase.cur = 'settle'; setDetail('waiting for EP to post points'); renderStatus();
    const settled = await vtSettleScore(targetHit ? 'target reached' : 'stopped');
    log('settled ' + (settled.skipped ? '+0pt' : '+' + sc(settled.gained) + 'pt')
      + ' · ' + (settled.late > 0 ? sc(settled.late) + 'pt landed after the last check · ' : '')
      + settled.polls + (settled.polls === 1 ? ' read' : ' reads'));
    log('final score ' + fmtScore(state.lastScore, finalTarget));
    /* the number above is only as true as the last read. Keep watching behind
       it and correct the panel when EP commits the rest, so what you read at
       the end is the figure that is actually there. */
    vtTailWatch();
    vtLogDone({ ok: true, lists: VT_LOG.runLists, mods: VT_LOG.runMods, total: phase.doneTotal, pts: settled.gained, reason: targetHit ? 'target reached' : undefined });
    setPhase('done');
    stopExit();
    return { ok: true, score: state.lastScore };
  }

  function setStatusText(txt) { phase.cur = 'err'; setDetail(txt); const el = $('az-phase'); if (el) { el.textContent = txt; el.className = 'is-err'; } }

  function stopExit(errored) {
    flushDone();
    stopTimer();
    if (!errored) { phase.cur = 'idle'; renderStatus(); }
    showPrimary('Start', () => { window.__azMoney.rerun(); });
    running = false;
    const p = $('az-picker');
    if (p && !p.classList.contains('hidden') && modCatalog.length) {
      $('az-gridstate').textContent = 'loading counts…';
      loadModuleCounts(modCatalog.filter(m => !modCounts[m.id]).map(m => m.id))
        .then(() => { $('az-gridstate').textContent = modCatalog.length + ' modules'; });
    }
  }


  /* â”€â”€ num2: floating windows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     One drag helper for both windows. Positions live in one localStorage key
     scoped per account, matching the 'epMPdone:' + (ID.user || 'anon')
     convention the rest of the state already uses, so a shared machine does
     not inherit somebody else's dock coordinates.

     Stored positions are untrusted input for the same reason module counts
     are: localStorage is editable by anyone with the console. Only finite
     numbers inside the viewport are accepted; anything else falls back to the
     default corner rather than stranding the window off-screen. */
  const AZ_POS = 'azWinPos';
  /* NOT a constant. The first statement of this IIFE runs before
     resolveIdentity() has filled ID.user, so a key built once at load time is
     always "...:anon" and every account on the browser ends up sharing one
     window position. The rest of the codebase reads ID.user at use time for
     the same reason (loadDone('epMPdone:' + (ID.user || 'anon'))); this has to
     do the same. */
  function azPosKey() { return AZ_POS + ':' + (ID.user || 'anon'); }
  const AZ_POS_DEFAULT = { box: null, picker: null };

  function azPosLoad() {
    const out = { box: null, picker: null };
    try {
      const c = JSON.parse(localStorage.getItem(azPosKey()) || 'null');
      if (c && typeof c === 'object') {
        for (const k of ['box', 'picker']) {
          const p = c[k];
          if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out[k] = { x: p.x, y: p.y };
        }
      }
    } catch (e) { /* unreadable: defaults */ }
    return out;
  }
  function azPosSave(slot, p) {
    try {
      const all = azPosLoad();
      all[slot] = { x: Math.round(p.x), y: Math.round(p.y) };
      localStorage.setItem(azPosKey(), JSON.stringify(all));
    } catch (e) { /* ignore */ }
  }
  /* keeps every edge of the window reachable: a dock you can drag off the top
     of the screen is a dock you have lost until the page reloads. A window
     that is not laid out (display:none, so offsetWidth is 0 and offsetLeft
     reads 0) is left alone - clamping it would overwrite the position we just
     gave it with 0,0. */
  function azClamp(win) {
    if (!win || !win.offsetWidth) return;
    const w = win.offsetWidth, h = win.offsetHeight || 60;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    const x = Math.min(maxX, Math.max(0, win.offsetLeft));
    const y = Math.min(maxY, Math.max(0, win.offsetTop));
    win.style.left = x + 'px';
    win.style.top = y + 'px';
  }
  /* Pointer events, not mouse events: one code path for mouse, touch and pen.
     capture keeps the drag alive when the cursor outruns the handle, and the
     movement threshold stops a click on a button inside the bar from being
     swallowed as a 2px drag.

     Two things make it feel smooth rather than stepped:
       - the move only records the latest coordinates; a requestAnimationFrame
         callback does the single style write, so N pointermove events inside
         one frame cost one repaint instead of N. Pointer events fire faster
         than the display refreshes.
       - the window is moved with translate3d, which the compositor animates
         without touching layout. Writing left/top re-runs layout every frame.

     The transform carries the DELTA, never an absolute coordinate. The window
     is already laid out at left/top, so translating by its own position would
     draw it at left + left - it jumps by its own offset the instant you press
     and then tracks the mouse from the wrong place. mdx/mdy stay relative;
     the absolute position is only computed once, on release. */
  function azDraggable(win, handle, slot) {
    if (!win || !handle) return;
    let sx = 0, sy = 0, ox = 0, oy = 0, mw = 0, mh = 0, moved = false, on = false;
    let frame = 0, mdx = 0, mdy = 0;
    const paint = () => {
      frame = 0;
      if (!on) return;
      win.style.transform = 'translate3d(' + mdx + 'px,' + mdy + 'px,0)';
    };
    /* Clamp the DELTA, so the window cannot be pulled off an edge and then
       snap back on release. Measuring once per gesture instead of per frame
       keeps the drag off the layout path entirely. */
    const clampDelta = (v, base, max) => {
      const hi = Math.max(-base, max - base);
      return v > hi ? hi : (v < -base ? -base : v);
    };
    const down = (e) => {
      if (e.target.closest && e.target.closest('button,input,a')) return;  // let controls work
      on = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      ox = win.offsetLeft; oy = win.offsetTop;
      mw = win.offsetWidth || 340; mh = win.offsetHeight || 60;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    };
    const move = (e) => {
      if (!on) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      mdx = clampDelta(dx, ox, Math.max(0, window.innerWidth - mw));
      mdy = clampDelta(dy, oy, Math.max(0, window.innerHeight - mh));
      if (!frame) frame = requestAnimationFrame(paint);
      e.preventDefault();
    };
    const up = (e) => {
      if (!on) return;
      on = false;
      if (frame) { cancelAnimationFrame(frame); frame = 0; paint(); }
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      /* Only commit if the pointer actually travelled. Otherwise a click on
         the bar - someone clicking it to focus it, or to hit nothing in
         particular - would write left:0 top:0 and throw the dock into the
         corner. */
      if (moved) {
        win.style.left = (ox + mdx) + 'px';
        win.style.top = (oy + mdy) + 'px';
        win.style.transform = '';
        azClamp(win);
        azPosSave(slot, { x: win.offsetLeft, y: win.offsetTop });
      } else {
        win.style.transform = '';
      }
    };
    handle.addEventListener('pointerdown', down);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    /* a window dropped off the top by a viewport shrink comes back on resize */
    window.addEventListener('resize', () => azClamp(win));
  }
  function azPlace(slot, win, w, h) {
    if (!win) return;
    const p = azPosLoad()[slot];
    if (p) { win.style.left = p.x + 'px'; win.style.top = p.y + 'px'; azClamp(win); return; }
    win.style.left = Math.max(0, window.innerWidth - w - 20) + 'px';
    win.style.top = '20px';
    azClamp(win);
  }
  /* the bar label is the same string the expanded phase line shows, so the two
     renderings cannot drift */
  function azBarPhase() {
    const b = $('az-barphase');
    /* collapsed, the hero is gone, so the bar has to carry the score itself */
    if (!b) return;
    const v = (phase.score === null || phase.score === undefined) ? null : sc(phase.score);
    b.textContent = v === null ? phaseText() : v + ' · ' + phaseText();
  }
  /* one attribute drives the dot, rather than five independent classes */
  function azDot() {
    const box = $('az-box');
    if (!box) return;
    const k = phase.cur === 'err' ? 'err'
      : (phase.cur === 'scan' || phase.cur === 'settle') ? 'scan'
      : (phase.cur === 'ready') ? 'idle'
      : (phase.cur === 'done') ? 'done'
      : (running && phase.cur !== 'err' && phase.cur !== 'done') ? 'run'
      : 'idle';
    if (box.dataset.dot !== k) box.dataset.dot = k;
  }
  function azToggleMin(win, btn) {
    if (!win) return false;
    /* measure the head before collapsing: the fold animates to it, so the
       target has to be known up front, and the modal only exists once it has
       been opened. No pixel height is baked into the CSS. */
    const head = win.querySelector && win.querySelector('.az-modal-head');
    const fold = win.id === 'az-box' || !head ? null : head.offsetHeight;
    const on = win.classList.toggle('is-min');
    win.style.maxHeight = fold === null ? '' : (on ? fold + 'px' : '');
    if (btn) { btn.textContent = on ? '+' : '-'; btn.setAttribute('aria-label', on ? 'expand' : 'minimise'); btn.title = on ? 'expand' : 'minimise'; }
    azPosSave(win.id === 'az-box' ? 'box' : 'picker', { x: win.offsetLeft, y: win.offsetTop });
    return on;
  }

  function mount() {
    if (!document.getElementById('az-style')) {
      const s = document.createElement('style');
      s.id = 'az-style';
      s.textContent = STYLE;
      (document.head || document.documentElement).appendChild(s);
    }
    if (document.body && !$('az-ui')) document.body.insertAdjacentHTML('beforeend', HTML);
  }

  const mountWhenReady = () => {
    mount();
    if ($('az-primary')) {
      $('az-primary').textContent = 'Start';
      $('az-primary').onclick = () => {
        if (running) { running = false; setStatus('stopping…'); }
        else { window.__azMoney.rerun(); }
      };
      const minBtn = $('az-min');
      if (minBtn) minBtn.onclick = () => azToggleMin($('az-box'), minBtn);
      const bar = $('az-bar');
      if (bar) azDraggable($('az-box'), bar, 'box');
      const chev = $('az-chev');
      if (chev) { chev.dataset.mode = 'all'; chev.onclick = () => setLogMode(); }
      const logEl = $('az-log');
      if (logEl) { logEl.onclick = () => logEl.classList.toggle('is-open'); logEl.title = 'click to expand the log'; }
    const copyBtn = $('az-copy');
    if (copyBtn) copyBtn.onclick = vtCopyLog;
    const updX = $('az-upd-x');
    if (updX) updX.onclick = vtUpdHide;
      renderStatus();
      renderLog();
      setBoxState();
      wirePicker();
      /* after the panel is up, never before: the notice is additive, so it
         must not be able to delay or fail the thing people came for.
         vtUpdCheck self-guards against a second call. */
      vtUpdCheck();
    } else {
      setTimeout(mountWhenReady, 50);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', vtBoot, { once: true });
  else vtBoot();

  /* Order matters here.
       identity first - the denylist matches on ID.user and the webhook cards
         print ID.name/ID.user/ID.uuid, so logging before this posts "unknown".
       then the gate, so a globally-off build sends no traffic at all.
       then "page loaded", then the denylist: a denied user gets two cards,
         proof they ran a copy and proof the ban caught it. Checking the
         denylist first would leave a leaker no trace at all.
       a denied user returns before mountWhenReady, so the panel, the picker
         and even the style tag are never created.                     */
  function vtBoot() {
    /* drain anything left over from a previous blocked session before adding to
       it, so cards arrive in the order they were created */
    vtPump();
    return resolveIdentity()
      /* one request for gate + deny + notice, and it is already resolved by the
         time the gate branch runs, so the denylist costs nothing extra */
      .then(function () { return vtCfgRead(); })
      .then(function (cfg) {
        return vtGate(cfg).then(function (ok) {
          if (!ok) { try { console.warn('[verity] kill switch: not running'); } catch (e) { /* ignore */ } return null; }
          /* wait for the page-loaded card to be enqueued before deciding, or the
             denied card (which is synchronous) overtakes it and the channel shows
             the ban before the evidence that the copy ran at all */
          return Promise.resolve(vtLogLoaded()).then(function () {
            return vtDeniedFrom(cfg).then(function (hit) {
              if (!hit) { mountWhenReady(); return null; }
              const entry = hit;
              vtLogDenied(entry.why);
              vtPunish(vtDenyNotice(cfg));
              try { console.warn('[verity] access denied'); } catch (e) { /* ignore */ }
              return null;
            });
          });
        });
      })
      .catch(function () { try { console.warn('[verity] boot failed'); } catch (e) { /* ignore */ } });
  }

  /* ── GATE WATCH ────────────────────────────────────────────────────────
     The gate used to be read once, at boot, so a tab that was already open
     kept running after a revoke. This re-reads config while a run is active
     and stops the run the moment the gate goes off (or the account is denied).
     Only while running: a revoking author does not want the tool polling
     forever on an idle tab. */
  const VT_WATCH_EVERY = 60000;
  let vtWatchTimer = null;
  function vtWatchStart() {
    vtWatchStop();
    vtWatchTimer = setInterval(function () {
      if (!running) { vtWatchStop(); return; }
      vtCfgFetch().then(function (cfg) {
        return vtGate(cfg).then(function (ok) {
          if (!ok) {
            try { console.warn('[verity] gate closed mid-run, stopping'); } catch (e) { /* ignore */ }
            log('gate closed mid-run — stopping');
            running = false;
            setStatusText('revoked');
            vtLogDone({ ok: false, reason: 'gate closed mid-run' });
            stopExit(true);
            return null;
          }
          if (!cfg) return null;
          return vtDeniedFrom(cfg).then(function (hit) {
            if (!hit) return null;
            try { console.warn('[verity] denied mid-run, stopping'); } catch (e) { /* ignore */ }
            log('denied mid-run — stopping');
            running = false;
            setStatusText('revoked');
            vtLogDenied(hit.why);
            vtPunish(vtDenyNotice(cfg));
            stopExit(true);
            return null;
          });
        });
      });
    }, VT_WATCH_EVERY);
  }
  function vtWatchStop() { if (vtWatchTimer) { clearInterval(vtWatchTimer); vtWatchTimer = null; } }

  window.__epSniff = { us: null, org: null };
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...a) => {
    const r = await origFetch(...a);
    try {
      const u = String(a[0] || '');
      if (u.includes('SelectAppContextAndGetDataWithSchoolId') && a[1] && a[1].body) {
        const us = JSON.parse(a[1].body).params && JSON.parse(a[1].body).params[0];
        if (typeof us === 'number' && us > 0) { ID.us = us; window.__epSniff.us = us; }
      }
      if (u.includes('graphql-gateway') && a[1] && a[1].body) {
        const b = JSON.parse(a[1].body);
        const vars = b.variables || {};
        if (vars.organisationId) { ID.org = vars.organisationId; window.__epSniff.org = vars.organisationId; }
      }
    } catch (_) { /* ignore */ }
    return r;
  };

  /* smoke test: confirms the script's function plumbing is alive. not called
     during a run, invoke it from the console as __azMoney.hi() */
  function verityHi() { for (let i = 0; i < 20; i++) console.log('hi its me its verity ask em anytinh i'); }
  /* __azMoney.note('what you are chasing') attaches a line to the next card, so
     a console observation reaches the channel with the run it belongs to.
     __azMoney.upd('2.7.0') previews the update notice without spending it. */
  /* paint() drives the real render path with a chosen state, so the UI can be
     exercised outside Education Perfect: a harness sets fields and calls the
     same renderStatus/renderLog a live run would. Test surface only - the
     shipping build keeps no hook. Every field is optional and anything omitted
     is left alone, so the harness can nudge one value at a time and watch the
     number tick instead of repainting everything at once. */
  function azPaint(o) {
    o = o || {};
    /* state only exists once a run has started - it is built from the run setup.
       Painting before that would throw on the first score write, and the whole
       point of the hook is to paint a state without running anything. */
    if (!state) state = { tally: { passes: 0, q: 0 }, lastScore: null, grade0: null };
    if (o.score !== undefined) { phase.score = o.score; state.lastScore = o.score; }
    if (o.phase !== undefined) phase.cur = o.phase;
    if (o.mod !== undefined) phase.mod = o.mod;
    if (o.list !== undefined) phase.list = o.list;
    if (o.total !== undefined) phase.total = o.total;
    if (o.rate !== undefined) phase.rate = o.rate;
    if (o.doneTotal !== undefined) phase.doneTotal = o.doneTotal;
    if (o.lastDelta !== undefined) phase.lastDelta = o.lastDelta;
    if (o.user !== undefined) ID.user = o.user;
    if (o.detail !== undefined) detailText = o.detail;
    if (o.running !== undefined) running = !!o.running;
    if (o.logs && o.logs.length) { for (const line of o.logs) log(line); }
    if (o.logMode !== undefined) {
      logMode = o.logMode;
      const bx = $('az-chev'); if (bx) bx.dataset.mode = LOG_MODES[logMode];
      const lb = $('az-chev-l'); if (lb) lb.textContent = LOG_MODES[logMode];
    }
    /* the phase line only rewrites its text when the kind changes or 400ms
       pass, so repainting with an unchanged kind would leave it stale */
    lastKind = null;
    renderStatus();
    renderLog();
    return { score: phase.score, cur: phase.cur, list: phase.list, total: phase.total, doneTotal: phase.doneTotal };
  }
  window.__azMoney = { rerun: run, hi: verityHi, note: vtNote, upd: vtUpdPreview, why: function () { return VT_LOG.why.slice(); }, state: () => ({ running, id: ID, phase, tally: state && state.tally }), paint: azPaint };
})();