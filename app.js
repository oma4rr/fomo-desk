/* Grok Bot desk app · STEP 10 (hosting plan B: read-only files through the tunnel, writes go through Telegram).
   Never a made-up number: a value the desk does not have shows "—" or an empty state. The data key arrives once in
   the #d= fragment, is kept in localStorage, removed from the address bar and never logged or shown. */
(function () {
  "use strict";
  const POLL_MS = 15000, STALE_MS = 90000, LIVE_MS = 5000, KEY = "desk.k", SEEN = "desk.seen";
  const BOTS = ["scanner", "analyst", "brain", "executor", "risk"];
  const NAMES = { scanner: "Scanner", analyst: "Analyst", brain: "Brain", executor: "Executor", risk: "Risk" };
  const COLORS = { scanner: "#64d2ff", analyst: "#ffd60a", brain: "#bf5af2", executor: "#00d35a", risk: "#ff6b9a" };
  const PLAN_B = "Plan B: the app is read-only. Do this from Telegram (send the command to the desk bot).";
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const reduce = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- data key + config ----------
  (function takeKey() {
    const h = location.hash || "";
    const m = h.match(/^#d=([A-Za-z0-9_-]{20,})/);
    if (m) {
      try { localStorage.setItem(KEY, m[1]); } catch (e) { /* private mode: keep in memory only */ window.__k = m[1]; }
      history.replaceState(null, "", location.pathname + location.search + "#/home");
    }
  })();
  const key = () => { try { return localStorage.getItem(KEY) || window.__k || null; } catch (e) { return window.__k || null; } };

  const S = { base: null, docs: {}, missing: {}, okAt: null, failAt: null, retryAt: 0, loaded: false, range: "LIVE",
              prevPts: {}, odo: null, actPages: [], seenAudit: {}, frame: { url: null, ts: null, busy: false } };

  // ---------- helpers ----------
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fomo = (u) => (typeof u === "string" && u.indexOf("https://fomo.family/") === 0) ? u : null; // links come only from the desk (links.py)
  const num = (v) => (typeof v === "number" && isFinite(v)) ? v : null;
  function money(v, sign) {
    v = num(v); if (v == null) return "—";
    const a = Math.abs(v), s = a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? "-" : (sign ? "+" : "")) + "$" + s;
  }
  function price(v) {
    v = num(v); if (v == null) return "—";
    if (v >= 1) return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 4 });
    return "$" + Number(v.toPrecision(4)).toString();
  }
  const pct = (v, d) => { v = num(v); return v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(d == null ? 2 : d) + "%"; };
  function big(v) {
    v = num(v); if (v == null) return "—";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M"; if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K"; return "$" + v.toFixed(0);
  }
  function hm(iso) {
    const t = Date.parse(iso); if (!isFinite(t)) return "—";
    return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const shortMint = (m) => m ? m.slice(0, 4) + "…" + m.slice(-4) : "";
  const symOf = (o) => (o && (o.symbol || o.name)) || shortMint(o && o.mint);
  function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 1800); }

  // ---------- fetching ----------
  async function loadConfig() {
    const r = await fetch("config.json", { cache: "no-store" });
    const c = await r.json();
    S.base = String(c.dataBaseUrl || "").replace(/\/+$/, "");
  }
  const url = (rel) => S.base + "/d/" + key() + "/" + rel;
  const HDR = { "ngrok-skip-browser-warning": "1" };
  async function get(rel, opt) {
    opt = opt || {};
    try {
      const r = await fetch(url(rel), { headers: HDR, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
      if (r.status === 404 && opt.may404) { S.missing[rel] = true; delete S.docs[rel]; return null; }
      if (!r.ok) throw new Error("http " + r.status);
      const d = await r.json();
      S.docs[rel] = d; delete S.missing[rel]; return d;
    } catch (e) { throw e; }
  }
  function need(route) {
    const files = ["state.json"];
    if (route.name === "home") files.push("chart.json", "activity.json", "account.json");
    if (route.name === "bots") BOTS.forEach(b => files.push("bots/" + b + ".json"));
    if (route.name === "activity") files.push("activity.json");
    if (route.name === "account") files.push("account.json");
    if (route.name === "coin") files.push({ rel: "coin/" + route.arg + ".json", may404: true });
    if (route.name === "audit") files.push({ rel: "audit/" + route.arg + ".json", may404: true }, "activity.json");
    return files;
  }
  async function refresh() {
    if (!S.base || !key()) { render(); return; }
    const route = parse();
    try {
      await Promise.all(need(route).map(f => typeof f === "string" ? get(f) : get(f.rel, f)));
      S.okAt = Date.now(); S.failAt = null; S.loaded = true;
    } catch (e) {
      S.failAt = Date.now();
    }
    S.retryAt = Date.now() + POLL_MS;
    render();
    frame();
  }

  // live screen: newest frame as a blob, double buffered (2 imgs, swap after load), never flashes
  async function frame() {
    const st = S.docs["state.json"]; if (!st || !st.screen || !st.screen.file || S.frame.busy || !key()) return;
    if (S.frame.ts === st.screen.ts && S.frame.url) return;
    S.frame.busy = true;
    try {
      const r = await fetch(url(st.screen.file), { headers: HDR, cache: "no-store", credentials: "omit" });
      if (!r.ok) throw new Error("http " + r.status);
      const lm = r.headers.get("Last-Modified");
      const b = await r.blob();
      const u = URL.createObjectURL(b);
      await new Promise((ok) => { const im = new Image(); im.onload = ok; im.onerror = ok; im.src = u; });
      const old = S.frame.url; S.frame.url = u; S.frame.ts = st.screen.ts || (lm ? new Date(lm).toISOString() : null);
      paintFrames();
      if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    } catch (e) { /* keep the last good frame */ }
    S.frame.busy = false;
  }
  function paintFrames() {
    $$(".screen").forEach(sc => {
      const ims = $$("img", sc); if (ims.length < 2 || !S.frame.url) return;
      const cur = ims.find(i => i.classList.contains("show")), nxt = ims.find(i => i !== cur) || ims[0];
      if (cur && cur.dataset.u === S.frame.url) return;
      nxt.onload = () => { nxt.classList.add("show"); if (cur) cur.classList.remove("show"); };
      nxt.dataset.u = S.frame.url; nxt.src = S.frame.url;
      const ph = $(".ph", sc); if (ph) ph.hidden = true;
    });
    const fi = $("#full img"); if (fi && S.frame.url && fi.dataset.u !== S.frame.url) { fi.dataset.u = S.frame.url; fi.src = S.frame.url; }
    paintScreenLabel();
  }

  // ---------- routing ----------
  function parse() {
    const h = (location.hash || "#/home").replace(/^#\/?/, "");
    const [name, arg, q] = h.split("/");
    const ok = ["home", "bots", "activity", "account", "coin", "audit"];
    return { name: ok.indexOf(name) >= 0 ? name : "home", arg: arg ? decodeURIComponent(arg) : null, q: q || null };
  }
  const go = (h) => { if (location.hash !== h) location.hash = h; else render(); };
  window.addEventListener("hashchange", () => { window.scrollTo(0, 0); render(); refresh(); });
  $$("#tabbar .tab").forEach(b => b.addEventListener("click", () => go("#/" + b.dataset.tab)));

  // ---------- offline row ----------
  function offlineRow() {
    const el = $("#offline");
    const st = S.docs["state.json"];
    const stale = st && isFinite(Date.parse(st.ts)) && (Date.now() - Date.parse(st.ts) > STALE_MS);
    if (!S.failAt && !stale) { el.hidden = true; return; }
    const n = Math.max(0, Math.ceil((S.retryAt - Date.now()) / 1000));
    const last = st ? hm(st.ts) : "never";
    el.textContent = "Desk offline · retrying in " + n + "s · last update " + last;
    el.hidden = false;
  }
  setInterval(() => { offlineRow(); paintScreenLabel(); }, 1000);

  // ---------- pieces ----------
  function navbar(st, acc) {
    const h = (acc && acc.handle) || "";
    const rows = ((S.docs["activity.json"] || {}).rows || []);
    const newest = rows.length ? rows[0].id : null;
    let seen = null; try { seen = localStorage.getItem(SEEN); } catch (e) {}
    const dot = newest != null && String(newest) !== seen;
    return `<div class="nav">
      <button class="avatar" data-go="#/account" aria-label="Account"><span>${esc(h ? h[0].toUpperCase() : "G")}</span></button>
      <button class="brand" data-go="#/bots">Grok Bot<small>›</small></button>
      <button class="icon-btn" data-act="search" aria-label="Search"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg></button>
      <button class="icon-btn" data-go="#/activity" aria-label="Activity"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>${dot ? '<i class="dot"></i>' : ""}</button></div>`;
  }
  function odoHTML(str) {
    return '<span class="odo" aria-label="' + esc(str) + '">' + Array.from(str).map(ch => /\d/.test(ch)
      ? '<span class="d"><span data-v="' + ch + '" style="transform:translateY(-' + ch + 'em)">' + "0123456789".split("").map(n => "<i>" + n + "</i>").join("") + "</span></span>"
      : "<span>" + esc(ch) + "</span>").join("") + "</span>";
  }
  // render the previous value, then roll changed digits to the new one (600ms ease-out, 30ms stagger)
  function odometer(el, str) {
    const prev = S.odo;
    S.odo = str;
    if (!prev || prev.length !== str.length || reduce()) { el.innerHTML = odoHTML(str); return; }
    el.innerHTML = odoHTML(prev);
    const ds = $$(".d > span", el);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      let k = 0;
      Array.from(str).filter(c => /\d/.test(c)).forEach((c, i) => {
        const sp = ds[i]; if (!sp || sp.dataset.v === c) return;
        sp.style.transitionDelay = (k++ * 30) + "ms"; sp.style.transform = "translateY(-" + c + "em)"; sp.dataset.v = c;
      });
    }));
  }
  function screenCard(st) {
    return `<div class="live"><button class="screen" data-act="full" aria-label="Open the live screen">
        <img alt="" /><img alt="" /><div class="ph">${S.frame.url ? "" : "No frame yet"}</div>
        <div class="tl"><i class="rec grey"></i><span class="lbl">…</span></div>
        <div class="tr">${laneTag(st)}</div></button>
      ${lastOrder(st)}</div>`;
  }
  function laneTag(st) {
    const l = st && st.lane;
    if (!l) return '<span class="sub">Idle</span>';
    const n = String(l.bot || l).toLowerCase(), what = l.doing || (n === "executor" ? "buying" : n === "risk" ? "selling" : "working");
    return '<span style="color:' + (COLORS[n] || "#fff") + '">' + esc((NAMES[n] || l.bot || l) + " · " + what) + "</span>";
  }
  function paintScreenLabel() {
    const st = S.docs["state.json"]; const ts = S.frame.ts || (st && st.screen && st.screen.ts);
    const t = Date.parse(ts);
    const live = S.frame.url && isFinite(t) && Date.now() - t < LIVE_MS;
    const txt = !S.frame.url ? ((st && st.screen && st.screen.label) || "No frame yet") : live ? "Live · Bot's computer" : "Last frame " + hm(ts);
    $$(".screen .tl, #full .tl").forEach(el => {
      const r = $(".rec", el), l = $(".lbl", el);
      if (r) r.classList.toggle("grey", !live); if (l && l.textContent !== txt) l.textContent = txt;
    });
  }
  function checks(c) {
    c = c || {};
    return '<span class="checks">' + ["screen", "api", "chain"].map(k => {
      const v = c[k]; return '<i class="chk ' + (v === true ? "ok" : v === false ? "no" : "") + '" title="' + k + '">' + (v === true ? "✓" : v === false ? "✕" : "·") + "</i>";
    }).join("") + "</span>";
  }
  function lastOrder(st) {
    const o = st && st.lastOrder;
    if (!o) return '<div class="lastorder"><span class="sub">No order yet</span>' + checks(null) + "</div>";
    const c = o.checks || {}, all = c.screen === true && c.api === true && c.chain === true;
    const verb = o.side === "sell" ? "Sold" : "Bought";
    const tail = all ? "verified" : (o.status === "unverified" || c.screen === false || c.api === false || c.chain === false) ? "unverified" : esc(o.status || "");
    return `<div class="lastorder"><span>${esc(verb + " " + symOf(o))} · ${money(o.fillUsd != null ? o.fillUsd : o.usd)} · ${tail}</span>${checks(c)}</div>`;
  }
  function ring(score) {
    const s = num(score), r = 23, c = 2 * Math.PI * r, f = s == null ? 0 : Math.max(0, Math.min(100, s)) / 100;
    const col = s == null ? "rgba(235,235,245,0.3)" : s >= 70 ? "#00d35a" : "#ff453a";
    return `<svg class="ring" viewBox="0 0 54 54"><circle cx="27" cy="27" r="${r}" fill="none" stroke="#2c2c2e" stroke-width="5"/>
      <circle cx="27" cy="27" r="${r}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 27 27)"/>
      <text x="27" y="32" text-anchor="middle" font-size="15" font-weight="700" fill="#fff">${s == null ? "—" : Math.round(s)}</text></svg>`;
  }
  function botBody(b, full) {
    const n = b.name;
    if (n === "scanner") {
      const f = (b.feed || []).slice(0, full ? 20 : 4);
      return '<div class="feed">' + (f.length ? f.map(x => x.verdict === "pass"
        ? '<div class="p">' + esc(symOf(x)) + " → Analyst</div>"
        : '<div><span class="k">' + esc(symOf(x)) + '</span> <span class="ter">' + esc(x.reason || "") + "</span></div>").join("") : '<div class="ter">No pools yet</div>') + "</div>";
    }
    if (n === "analyst") {
      const a = b.last;
      if (!a) return '<div class="strips">' + "<i></i>".repeat(8) + '</div><div class="ter">Nothing taken apart yet</div>';
      return `<div style="display:flex;gap:12px;align-items:center"><div style="flex:1"><div class="strips">${(a.layers || []).map(l => '<i class="' + (l.pass === true ? "ok" : l.pass === false ? "no" : "") + '"></i>').join("")}</div>
        <div class="sub" style="font-size:13px">${esc(symOf(a))} · ${esc(a.social || "Social: off")}</div></div>${ring(a.score)}</div>`;
    }
    if (n === "brain") {
      const l = b.last;
      const rule = l && l.rule;
      return `<div class="sub" style="font-size:14px">${l ? esc(money(l.sizeUsd) + " · " + (num(l.pctOfCash) == null ? "—" : Math.round(l.pctOfCash) + "%") + " of cash") : "No size yet"}</div>
        <div class="pills"><span class="pill mono" style="${rule && /full/.test(rule) ? "color:#bf5af2" : ""}">80+ = full size</span><span class="pill mono" style="${rule && /half/.test(rule) ? "color:#bf5af2" : ""}">under 80 = half size</span></div>`;
    }
    if (n === "executor") return '<div class="bar">' + esc(b.bar || "Idle") + "</div>";
    if (n === "risk") return '<div class="pills">' + (b.pills || []).map(p => '<span class="pill mono ' + (p.color === "red" ? "red" : "green") + '">' + esc(p.text) + "</span>").join("") + "</div>";
    return "";
  }
  function botCard(b) {
    const c = b.color || COLORS[b.name];
    return `<div class="bot"><div class="bh"><i class="bdot" style="background:${c}"></i><span style="color:${c}">${esc(NAMES[b.name] || b.name)}</span>
      <span class="ter" style="margin-left:auto;font-weight:400;font-size:13px">${esc(statusText(b))}</span></div>
      <div class="big">${esc(b.label || "—")}</div>${botBody(b)}</div>`;
  }
  function statusText(b) { return b.status === "running" ? "Running" : b.status === "paused" ? "Paused" : b.status === "down" ? "Down" : "—"; }
  const ICON = { bought: ["↓", "#0a84ff"], sold: ["↑", "#00d35a"], stopped: ["!", "#ff453a"], rejected: ["✕", "#636366"] };
  function actRow(r) {
    const ic = ICON[r.kind] || ["·", "#636366"], L = fomo(r.link);
    const tap = r.mint ? "#/" + (r.tap === "audit" ? "audit" : "coin") + "/" + encodeURIComponent(r.mint) : "";
    const col = r.kind === "sold" ? "up" : r.kind === "stopped" ? "down" : r.kind === "rejected" ? "ter" : "";
    return `<div class="row" role="button" tabindex="0" ${tap ? 'data-go="' + esc(tap) + '"' : ""}>
      <span class="ic" style="background:${ic[1]}33;color:${ic[1]}">${ic[0]}</span>
      <span class="mid"><div class="t">${esc(r.title || "")}</div><div class="s">${esc(r.subtitle || "")}</div></span>
      <span class="r"><div class="${col}">${esc(r.value || "")}</div>${L ? '<a class="fomo" href="' + esc(L) + '" target="_blank" rel="noopener noreferrer" data-ext="1">Open on FOMO</a>' : ""}</span></div>`;
  }

  // ---------- skeletons (loading = #1c1c1e blocks in the final layout) ----------
  const sk = (h, w, mt) => `<div class="sk" style="height:${h}px;${w ? "width:" + w + ";" : ""}margin-top:${mt || 0}px"></div>`;
  const SKEL = {
    home: () => sk(44) + sk(66, "70%", 10) + sk(22, "40%", 8) + sk(230, null, 14) + sk(44, null, 8) + `<div class="sk" style="aspect-ratio:16/9;border-radius:22px;margin-top:14px"></div>` + sk(24, "45%", 26) + `<div style="display:flex;gap:10px;margin-top:10px">${sk(176, "78%")}${sk(176, "22%")}</div>` + sk(24, "45%", 26) + sk(300, null, 10),
    bots: () => sk(40, "40%") + [1, 2, 3, 4, 5].map(() => sk(170, null, 12)).join(""),
    activity: () => sk(40, "50%") + sk(480, null, 12),
    account: () => sk(40, "50%") + sk(44, null, 14) + sk(60, null, 12) + sk(110, null, 12) + sk(400, null, 12),
    coin: () => sk(44, "30%") + sk(30, "60%", 8) + sk(48, "55%", 10) + sk(220, null, 14) + sk(64, null, 14) + sk(60, null, 12) + sk(50, null, 16),
    audit: () => sk(44, "30%") + sk(30, "60%", 8) + sk(260, null, 18) + sk(60, null, 12),
  };

  // ---------- screens ----------
  function home(st) {
    const acc = S.docs["account.json"], ch = S.docs["chart.json"], act = S.docs["activity.json"];
    const running = (st.bots || []).filter(b => b.status === "running").length;
    const r = ch && ch.ranges && ch.ranges[S.range];
    const hasLine = r && (r.points || []).length >= 2;
    const rows = act ? (act.rows || []).slice(0, 5) : null;
    const tp = num(st.todayPct), mult = num(st.multiplier);
    return navbar(st, acc) + `
      <div class="bal-row"><span class="bal" id="bal"></span>${st.mode === "PAPER" ? '<span class="pill paper">PAPER</span>' : ""}</div>
      <div class="today"><span class="${tp == null ? "ter" : tp >= 0 ? "up" : "down"}">${pct(tp)}</span><span class="ter">today</span>
        ${mult == null ? "" : '<span class="pill mult">' + mult.toFixed(2) + "×</span>"}</div>
      ${st.buysOff ? '<div class="note">Buys off: ' + esc(st.buysOff) + "</div>" : ""}
      <div class="chart"><canvas id="line"></canvas>${hasLine ? "" : '<div class="empty">' + esc(st.empty || (ch ? "Waiting for the first trade" : "")) + "</div>"}</div>
      <div class="ranges">${["LIVE", "1H", "4H", "1D", "1W", "ALL"].map(k => '<button data-range="' + k + '" class="' + (k === S.range ? "on" : "") + '">' + k + "</button>").join("")}</div>
      ${st.empty && hasLine ? '<div class="note" style="text-align:center">' + esc(st.empty) + "</div>" : ""}
      ${screenCard(st)}
      <div class="h2"><span>Bots · ${running} running</span><button data-go="#/bots">See all</button></div>
      <div class="carousel" id="car">${(st.bots || []).map(botCard).join("")}</div>
      <div class="h2"><span>Activity</span><button data-go="#/activity">See all</button></div>
      ${rows == null ? sk(300) : rows.length ? '<div class="rows">' + rows.map(actRow).join("") + "</div>" : '<div class="rows"><div class="emptybox">' + esc((act && act.empty) || "Nothing yet tonight") + "</div></div>"}`;
  }
  function afterHome(st) {
    odometer($("#bal"), money(st.balance));
    const ch = S.docs["chart.json"], r = ch && ch.ranges && ch.ranges[S.range];
    if (r && (r.points || []).length >= 2 && window.DeskChart) {
      const k = S.range, prev = S.prevPts[k]; S.prevPts[k] = r.points.length;
      DeskChart.line($("#line"), { points: r.points, marks: r.marks || [], start: ch.start }, prev);
    }
  }
  function bots(st) {
    const open = (st.positions || []).filter(p => !p.closedAt).length;
    return '<div class="title">Bots</div>' + BOTS.map(n => {
      const b = (st.bots || []).find(x => x.name === n) || { name: n, status: null };
      const d = S.docs["bots/" + n + ".json"], c = b.color || COLORS[n];
      const dotc = b.status === "running" ? "#00d35a" : b.status === "paused" ? "#ff9f0a" : "#ff453a";
      const paused = d ? !!d.paused : b.status === "paused";
      const lock = n === "risk" && open > 0;
      const rows = d ? (d.rows || []).slice(0, 20) : null;
      return `<div class="card" style="margin-top:12px"><div class="bh" style="display:flex;align-items:center;gap:8px;font-weight:600">
          <i class="bdot" style="width:8px;height:8px;border-radius:50%;background:${dotc}"></i><span style="color:${c}">${NAMES[n]}</span>
          <span class="ter" style="font-weight:400;font-size:13px">${esc(statusText(b))} · ${esc(b.label || "—")}</span>
          <span style="margin-left:auto" class="switch ${paused ? "" : "on"}" role="switch" aria-checked="${!paused}" aria-disabled="true" title="${lock ? "Locked while a position is open" : esc(PLAN_B)}"></span></div>
        <div class="lock" style="margin-top:6px">${lock ? "Pause locked: a position is open" : "Pause from Telegram: pause " + NAMES[n] + " · plan B"}</div>
        <div style="margin-top:8px">${botBody(b, true)}</div>
        <div class="sub" style="font-size:13px;margin:12px 0 4px">Last 20 decisions</div>
        ${rows == null ? sk(120) : rows.length ? '<div class="rows" style="background:#2c2c2e">' + rows.map(x => decisionRow(n, x)).join("") + "</div>" : '<div class="emptybox" style="padding:16px">Nothing yet tonight</div>'}
        <button class="btn" style="margin-top:10px;width:100%" data-go="#/account/${n}">Settings</button></div>`;
    }).join("");
  }
  function decisionRow(n, x) {
    const L = fomo(x.link), tap = x.mint ? (n === "scanner" || n === "analyst" ? "#/audit/" : "#/coin/") + encodeURIComponent(x.mint) : "";
    let right = "";
    if (n === "analyst" && num(x.score) != null) right = Math.round(x.score) + "/100";
    if (n === "brain") right = money(x.sizeUsd);
    if (n === "executor" || n === "risk") right = money(x.fillUsd != null ? x.fillUsd : x.usd);
    const sub = [x.decision, x.reason, hm(x.ts)].filter(Boolean).join(" · ");
    return `<div class="row" role="button" tabindex="0" ${tap ? 'data-go="' + esc(tap) + '"' : ""}><span class="mid"><div class="t">${esc(symOf(x))}</div><div class="s">${esc(sub)}</div></span>
      <span class="r"><div>${esc(right)}</div>${L ? '<a class="fomo" href="' + esc(L) + '" target="_blank" rel="noopener noreferrer" data-ext="1">Open on FOMO</a>' : ""}</span></div>`;
  }
  function activity() {
    const a = S.docs["activity.json"]; if (!a) return '<div class="title">Activity</div>' + sk(480, null, 12);
    const rows = (a.rows || []).concat(...S.actPages.map(p => p.rows || []));
    try { if (a.rows && a.rows.length) localStorage.setItem(SEEN, String(a.rows[0].id)); } catch (e) {}
    const last = S.actPages.length ? S.actPages[S.actPages.length - 1] : a;
    return '<div class="title">Activity</div>' + (rows.length ? '<div class="rows">' + rows.map(actRow).join("") + "</div>" +
      (last.next ? '<button class="btn" style="width:100%;margin-top:12px" data-act="more" data-next="' + esc(last.next) + '">Load more</button>' : "")
      : '<div class="rows"><div class="emptybox">' + esc(a.empty || "Nothing yet tonight") + "</div></div>");
  }
  function back() { return '<button class="back" data-act="back">‹ Back</button>'; }
  function coin(st, mint) {
    const rel = "coin/" + mint + ".json", c = S.docs[rel];
    if (S.missing[rel]) return back() + `<div class="emptybox">No trade data for this coin tonight.<br/><button class="btn" style="margin-top:14px" data-go="#/audit/${encodeURIComponent(mint)}">See its audit</button></div>`;
    if (!c) return SKEL.coin();
    const p = c.position, watch = p && p.mode === "FOMO", L = fomo(c.link);
    const up = num(c.pctSinceEntry);
    const age = num(c.ageHours) == null ? null : c.ageHours < 1 ? Math.round(c.ageHours * 60) + "m old" : Math.round(c.ageHours) + "h old";
    return back() + `<div style="display:flex;align-items:center;gap:8px;margin-top:4px"><span style="font:700 28px var(--disp)">${esc(c.name || c.symbol || shortMint(mint))}</span>
        ${st.mode === "PAPER" ? '<span class="pill paper">PAPER</span>' : ""}${c.shield ? '<span class="chip">🛡 ' + esc(c.shield) + "</span>" : ""}</div>
      <div class="sub">${esc([c.symbol, c.chain || "Solana", age].filter(Boolean).join(" · "))}</div>
      <div class="price">${price(c.price)}</div>
      ${up == null ? "" : '<div class="' + (up >= 0 ? "up" : "down") + '">' + (up >= 0 ? "▲ " : "▼ ") + Math.abs(up).toFixed(1) + "% since entry</div>"}
      <div class="chart" style="height:220px"><canvas id="candles"></canvas>${(c.candles || []).length ? "" : '<div class="empty">No candles yet</div>'}</div>
      <div class="stats"><div><span class="ter">Market cap</span><b>${big(c.marketCap)}</b></div><div><span class="ter">Liquidity</span><b>${big(c.liquidityUsd)}</b></div>
        <div><span class="ter">Holders</span><b>${num(c.holders) == null ? "—" : c.holders.toLocaleString("en-US")}</b></div></div>
      <div class="card" style="margin-top:12px">${p ? (watch
        ? "Your position · " + esc(money(p.sizeUsd)) + " in · held before the desk<div class=\"note\">Watch only: the desk never sells a holding it adopted (Omar, 2026-11-26).</div>"
        : "Your position · " + esc(money(p.sizeUsd)) + " in · " + esc(p.bot || "Executor") + '<div class="note">Now ' + esc(money(p.valueUsd)) + " · stop " + esc(price(p.stopPrice)) + "</div>")
        : '<span class="sub">No open position</span>'}</div>
      ${(c.history || []).length ? '<div class="h2"><span>Earlier tonight</span></div><div class="rows">' + c.history.map(h => `<div class="row"><span class="mid"><div class="t">${esc(h.exitReason || "Closed")}</div><div class="s">${esc(hm(h.openedAt) + " → " + hm(h.closedAt))}</div></span><span class="r ${num(h.pnlUsd) >= 0 ? "up" : "down"}">${money(h.pnlUsd, true)}</span></div>`).join("") + "</div>" : ""}
      <div class="btns">${L ? '<a class="btn blue" href="' + esc(L) + '" target="_blank" rel="noopener noreferrer">Open on FOMO</a>' : ""}
        <button class="btn red" data-act="sell" ${p ? "" : "disabled"}>Sell now</button></div>
      <div style="text-align:center;margin-top:10px"><button class="h2" style="display:inline;margin:0;font-size:15px;color:var(--blue)" data-go="#/audit/${encodeURIComponent(mint)}">See audit</button></div>`;
  }
  function afterCoin(mint) {
    const c = S.docs["coin/" + mint + ".json"];
    if (c && (c.candles || []).length && window.DeskChart) DeskChart.candles($("#candles"), c.candles, c.exitLine);
  }
  function audit(st, mint) {
    const rel = "audit/" + mint + ".json", a = S.docs[rel];
    if (S.missing[rel]) return back() + '<div class="emptybox">No audit for this coin tonight</div>';
    if (!a) return SKEL.audit();
    const L = fomo(a.link);
    const sc = num(a.score);
    const ar = ((S.docs["activity.json"] || {}).rows || []).find(r => r.mint === mint);
    const nm = a.name || a.symbol || (ar && ar.title ? ar.title.replace(/^\S+\s/, "") : shortMint(mint));
    return back() + `<div style="font:700 28px var(--disp);margin-top:4px">${esc(nm)}</div>
      <div class="sub">${esc(a.symbol || "")}${a.reason ? " · " + esc(a.reason) : ""}</div>
      <div class="discs" id="discs">${(a.layers || []).map(l => `<div class="disc" data-r="${l.pass === true ? "ok" : l.pass === false ? "no" : ""}"><div class="c">${l.n}</div>
        <div>${esc(l.name)}</div><div class="v">${esc(l.value == null ? "—" : l.value)}</div></div>`).join("")}<i class="beam" hidden></i></div>
      <div class="card" style="display:flex;align-items:center;gap:12px">${ring(sc)}<div><div style="font-weight:600">${a.passed == null ? "Not scored" : a.passed ? "Passed" : "Rejected"}</div>
        <div class="sub" style="font-size:13px">${esc(a.social || "Social: off")}</div></div></div>
      <div class="btns">${L ? '<a class="btn blue" href="' + esc(L) + '" target="_blank" rel="noopener noreferrer">Open on FOMO</a>' : ""}</div>`;
  }
  // a cyan beam reads each layer once per coin, then the green check / red result shows
  function afterAudit(mint) {
    const ds = $$("#discs .disc"); if (!ds.length) return;
    const show = (d) => { const r = d.dataset.r; d.classList.remove("reading"); if (r) d.classList.add(r); $(".c", d).textContent = r === "ok" ? "✓" : r === "no" ? "✕" : $(".c", d).textContent; };
    if (S.seenAudit[mint] || reduce()) { ds.forEach(show); return; }
    S.seenAudit[mint] = true;
    const beam = $("#discs .beam"); beam.hidden = false;
    ds.forEach((d, i) => setTimeout(() => {
      d.classList.add("reading");
      beam.style.top = (d.offsetTop + 28) + "px"; beam.style.left = d.offsetLeft + "px"; beam.style.right = "auto"; beam.style.width = d.offsetWidth + "px";
      setTimeout(() => show(d), 300);
      if (i === ds.length - 1) setTimeout(() => beam.hidden = true, 400);
    }, i * 350));
  }
  function account(st, focus) {
    const a = S.docs["account.json"]; if (!a) return '<div class="title">Account</div>' + SKEL.account();
    const prof = fomo(a.profileUrl || st.profileUrl), inv = fomo(a.inviteUrl || st.signupUrl);
    const groups = a.settings || {};
    const push = a.pushes || {};
    return `<div class="title">Account</div>
      <div class="seg" title="${esc(PLAN_B)}"><button class="${a.mode === "PAPER" ? "on" : ""}" disabled>PAPER</button><button class="${a.mode === "LIVE" ? "on" : ""}" disabled>LIVE</button></div>
      <div class="note">LIVE needs you to type LIVE. Plan B: switch from Telegram. PAPER until you decide.</div>
      <div class="rows" style="margin-top:14px"><div class="row"><span class="mid"><div class="t">Paper cash</div><div class="s">read-only in plan B</div></span><span class="r">${money(a.paperCash)}</span></div>
        ${prof ? `<a class="row" href="${esc(prof)}" target="_blank" rel="noopener noreferrer"><span class="mid"><div class="t">Your FOMO profile</div><div class="s">@${esc(a.handle || "")}</div></span><span class="r ter">›</span></a>` : ""}
        ${inv ? `<button class="row" data-act="invite" data-url="${esc(inv)}"><span class="mid"><div class="t">Invite a friend</div><div class="s">Share your FOMO link</div></span><span class="r ter">›</span></button>` : ""}</div>
      ${Object.keys(groups).map(g => `<div class="h2" id="g-${esc(g)}"><span>${esc(NAMES[g] || g[0].toUpperCase() + g.slice(1))}</span></div><div class="rows">${Object.keys(groups[g]).map(k => setRow(k, groups[g][k])).join("")}</div>`).join("")}
      <div class="h2"><span>Copy picks</span></div><div class="seg" title="${esc(PLAN_B)}">${["Off", "24h", "12h", "6h"].map(x => '<button disabled class="' + ((a.copyPicks || "off").toLowerCase() === x.toLowerCase() || (x === "Off" && !a.copyPicks) ? "on" : "") + '">' + x + "</button>").join("")}</div>
      <div class="h2"><span>Pushes</span></div>
      <div class="rows"><div class="row"><span class="mid"><div class="t">${esc(push.label || "Telegram only · not connected")}</div><div class="s">Web push: plan B is Telegram only</div></span><span class="r ${push.connected ? "up" : "ter"}">${push.connected ? "Connected" : "Not connected"}</span></div>
        <button class="row" disabled style="opacity:.45"><span class="mid"><div class="t">Send test push</div><div class="s">${push.connected ? "Send test to the desk bot in Telegram" : "After Telegram is connected"}</div></span></button>
        <div class="row"><span class="mid"><div class="t">Watch in Grok Bot</div><div class="s">In the Grok Bot app, open this bot's computer to watch the desk live</div></span></div></div>
      <div class="note" style="margin-top:12px">${esc(PLAN_B)}</div>`;
  }
  function setRow(k, s) {
    const v = s && typeof s === "object" ? s.value : s;
    const isNum = typeof v === "number";
    const label = k.replace(/_/g, " ");
    return `<div class="set"><div class="l"><span>${esc(label)}</span><b class="val">${esc(v == null ? "—" : isNum ? v : String(v))}</b></div>
      ${isNum && num(s.min) != null && num(s.max) != null ? `<input type="range" disabled min="${s.min}" max="${s.max}" value="${v}" step="any" aria-label="${esc(label)}"/>` : ""}</div>`;
  }

  // ---------- render ----------
  function render() {
    const route = parse();
    $$("#tabbar .tab").forEach(b => b.classList.toggle("on", b.dataset.tab === (["coin", "audit"].indexOf(route.name) >= 0 ? "home" : route.name)));
    const view = $("#view");
    if (!key()) { view.innerHTML = '<div class="title">Grok Bot</div><div class="emptybox">Open this app once from the link Grok Bot sent you.<br/>It carries the private key to your desk data.</div>'; offlineRow(); return; }
    const st = S.docs["state.json"];
    const car = $("#car"), carX = car ? car.scrollLeft : 0;
    if (!st) { view.innerHTML = (SKEL[route.name] || SKEL.home)(); offlineRow(); return; }
    let html = "";
    if (route.name === "home") html = home(st);
    else if (route.name === "bots") html = bots(st);
    else if (route.name === "activity") html = activity();
    else if (route.name === "account") html = account(st, route.arg);
    else if (route.name === "coin") html = coin(st, route.arg);
    else if (route.name === "audit") html = audit(st, route.arg);
    view.innerHTML = html;
    if (route.name === "home") { afterHome(st); const c2 = $("#car"); if (c2) c2.scrollLeft = carX; }
    if (route.name === "coin") afterCoin(route.arg);
    if (route.name === "audit") afterAudit(route.arg);
    if (route.name === "account" && route.arg && !render.scrolled) { const g = $("#g-" + route.arg); if (g) { g.scrollIntoView(); render.scrolled = route.arg; } }
    if (route.name !== "account") render.scrolled = null;
    S.frame.ts && paintFrames(); paintScreenLabel(); offlineRow();
  }

  // ---------- interactions ----------
  document.addEventListener("click", async (e) => {
    const ext = e.target.closest("[data-ext]"); if (ext) { e.stopPropagation(); return; }
    const t = e.target.closest("[data-go],[data-act],[data-range]"); if (!t) return;
    if (t.dataset.range) { S.range = t.dataset.range; render(); return; }
    if (t.dataset.go) { go(t.dataset.go); return; }
    const a = t.dataset.act;
    if (a === "back") { history.length > 1 ? history.back() : go("#/home"); }
    if (a === "full") openFull();
    if (a === "search") openSearch();
    if (a === "sell") openSell();
    if (a === "invite") invite(t.dataset.url);
    if (a === "more") { try { const p = await get(t.dataset.next); if (p) S.actPages.push(p); render(); } catch (err) { S.failAt = Date.now(); offlineRow(); } }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[role=button][data-go]")) go(e.target.dataset.go); });

  async function invite(u) {
    if (navigator.share) { try { await navigator.share({ title: "FOMO", url: u }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(u); toast("Link copied"); }
    catch (e) { const ta = document.createElement("textarea"); ta.value = u; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("Link copied"); } catch (e2) {} ta.remove(); }
  }
  function sheet(html) {
    const s = $("#sheet"); s.innerHTML = '<div class="in">' + html + "</div>"; s.hidden = false;
    s.onclick = (e) => { if (e.target === s || e.target.closest("[data-close]")) s.hidden = true; };
    return s;
  }
  function openSell() {
    const mint = parse().arg, c = S.docs["coin/" + mint + ".json"], p = c && c.position; if (!p) return;
    const watch = p.mode === "FOMO";
    const s = sheet(`<div style="font-weight:600;font-size:17px;margin-bottom:12px">Sell ${esc(symOf(c))}</div>
      <div class="seg" id="pcts">${[25, 50, 100].map(x => '<button data-p="' + x + '" class="' + (x === 100 ? "on" : "") + '">' + x + "%</button>").join("")}</div>
      <button class="btn red" style="width:100%;margin-top:14px" disabled>Confirm sell</button>
      <div class="note">${watch ? "Watch only: the desk never sells a holding it adopted." : "Plan B: the app is read-only. In Telegram send: sell " + esc(symOf(c)) + " 25|50|100. Nothing was sent."}</div>
      <button class="btn" style="width:100%;margin-top:12px" data-close="1">Close</button>`);
    $$("#pcts button", s).forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); $$("#pcts button", s).forEach(x => x.classList.toggle("on", x === b)); }));
  }
  function openSearch() {
    const s = sheet(`<input id="q" placeholder="Name, symbol or mint" autocomplete="off" autocapitalize="off" spellcheck="false"
      style="width:100%;height:44px;border-radius:12px;border:0;background:#2c2c2e;color:#fff;padding:0 12px;font-size:16px"/>
      <div id="res" class="rows" style="margin-top:12px;max-height:50vh;overflow:auto;background:#2c2c2e"></div><button class="btn" style="width:100%;margin-top:12px" data-close="1">Close</button>`);
    const q = $("#q", s), res = $("#res", s);
    const pool = () => {
      const m = {}; const add = (o, tap) => { if (o && o.mint && !m[o.mint]) m[o.mint] = { mint: o.mint, symbol: o.symbol, name: o.name, tap }; };
      const st = S.docs["state.json"] || {};
      (st.positions || []).forEach(p => add(p, "coin"));
      ((S.docs["activity.json"] || {}).rows || []).forEach(r => add({ mint: r.mint, symbol: r.title && r.title.split(" ").slice(1).join(" ") }, r.tap));
      (st.bots || []).forEach(b => (b.feed || []).forEach(f => add(f, "audit")));
      return Object.values(m);
    };
    const draw = () => {
      const v = q.value.trim().toLowerCase();
      let list = pool().filter(o => !v || [o.mint, o.symbol, o.name].some(x => x && String(x).toLowerCase().indexOf(v) >= 0)).slice(0, 20);
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q.value.trim()) && !list.length) list = [{ mint: q.value.trim(), tap: "coin" }];
      res.innerHTML = list.length ? list.map(o => `<div class="row" role="button" data-go="#/${o.tap === "audit" ? "audit" : "coin"}/${encodeURIComponent(o.mint)}"><span class="mid"><div class="t">${esc(o.symbol || o.name || shortMint(o.mint))}</div><div class="s">${esc(shortMint(o.mint))}</div></span></div>`).join("")
        : '<div class="emptybox">No coin the desk has seen tonight matches</div>';
    };
    q.addEventListener("input", draw); draw(); setTimeout(() => q.focus(), 50);
    res.addEventListener("click", () => { s.hidden = true; });
  }

  // full-screen live view: landscape allowed, pinch to zoom, double tap resets, "Open on FOMO" for the coin on screen
  function openFull() {
    const st = S.docs["state.json"] || {}, L = fomo(st.screen && st.screen.link);
    const f = $("#full");
    f.innerHTML = `<div class="bar2"><span class="tl" style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600"><i class="rec grey"></i><span class="lbl">…</span></span>
      <span style="font-size:13px">${laneTag(st)}</span><button class="back" data-close="1">Done</button></div>
      <img alt="Bot's computer" />${S.frame.url ? "" : '<div class="emptybox" style="position:absolute;inset:0;display:grid;place-items:center">No frame yet</div>'}
      <div class="bot2">${L ? '<a class="btn blue" href="' + esc(L) + '" target="_blank" rel="noopener noreferrer">Open on FOMO</a>' : ""}</div>`;
    f.hidden = false;
    const img = $("img", f); if (S.frame.url) { img.dataset.u = S.frame.url; img.src = S.frame.url; }
    let sc = 1, tx = 0, ty = 0, pts = {}, d0 = 0, s0 = 1, lastTap = 0, pan = null;
    const apply = () => img.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${sc})`;
    f.onpointerdown = (e) => { if (e.target.closest("a,button")) return; pts[e.pointerId] = e; const k = Object.keys(pts);
      if (k.length === 2) { const [a, b] = k.map(i => pts[i]); d0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); s0 = sc; }
      else { pan = { x: e.clientX - tx, y: e.clientY - ty }; const now = Date.now(); if (now - lastTap < 300) { sc = 1; tx = ty = 0; apply(); } lastTap = now; } };
    f.onpointermove = (e) => { if (!pts[e.pointerId]) return; pts[e.pointerId] = e; const k = Object.keys(pts);
      if (k.length === 2) { const [a, b] = k.map(i => pts[i]); sc = Math.max(1, Math.min(5, s0 * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / (d0 || 1))); apply(); }
      else if (pan && sc > 1) { tx = e.clientX - pan.x; ty = e.clientY - pan.y; apply(); } };
    f.onpointerup = f.onpointercancel = (e) => { delete pts[e.pointerId]; if (!Object.keys(pts).length) pan = null; };
    f.onclick = (e) => { if (e.target.closest("[data-close]")) { f.hidden = true; f.innerHTML = ""; } };
    paintScreenLabel();
  }

  // ---------- start ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  render();
  loadConfig().then(refresh, () => { S.failAt = Date.now(); S.retryAt = Date.now() + POLL_MS; render(); });
  setInterval(refresh, POLL_MS);
  window.addEventListener("resize", () => render());
})();
