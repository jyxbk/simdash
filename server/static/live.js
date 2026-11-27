"use strict";
// ---------------------------------------------------------------------------
// Live-Tab: aktueller Zustand vom Collector (SSE /api/live/stream, ~10 Hz).
// Nutzt Hilfen aus app.js (h, s, $, fmt, fmtDelta, pretty, trackName, gameName,
// comboKey, comboQuery, isCounting, getJSON, sectorTimes, SECTORS, MAP_* …).
// ---------------------------------------------------------------------------
const live = {
  es: null, data: null, age: null, rxAt: 0,
  combo: null, pb: null, pbSectors: null, laps: [], lapsKey: "",
  lapKey: "", trail: [], bounds: [], lastRate: null,
  map: null, wake: null, pollTimer: null,
};
const LIVE_STALE_S = 4;

/* --- Seiten (Routing in shell.js) ------------------------------------------ */
function showTab() {
  const page = currentPage(), tab = currentTab(), isLive = tab === "live";
  document.body.classList.toggle("is-live", isLive);
  document.body.dataset.tab = tab;
  document.body.dataset.page = page;
  $("#overview-view").hidden = tab !== "overview";
  $("#analyse-view").hidden = tab !== "analyse";
  $("#live-view").hidden = !isLive;
  $("#safety-view").hidden = page !== "safety";
  $("#collector-view").hidden = page !== "collector";
  $("#filters").hidden = isLive || page === "safety" || page === "collector";
  $("#tooltip").hidden = true;
  shellRoute();
  if (isLive) startLive(); else { stopLive(); if (live.wasLive) load(); }
  if (tab === "analyse") { if (live.lastTab === "analyse") redrawAnalyse(); openAnalyse(); }
  if (typeof cpSync === "function") cpSync();
  live.wasLive = isLive;
  live.lastTab = tab;
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", showTab);

function startLive() {
  if (live.es) return;
  live.es = new EventSource("/api/live/stream");
  live.es.onmessage = (e) => onLive(JSON.parse(e.data));
  live.es.onerror = () => { live.age = null; renderState(); };
  requestWake();
  if (!live.raf) live.raf = requestAnimationFrame(tick);
}
function stopLive() {
  if (live.es) { live.es.close(); live.es = null; }
  if (live.wake) { live.wake.release().catch(() => {}); live.wake = null; }
}
async function requestWake() {        // Bildschirm am Handy anlassen, solange Live offen ist
  try { if ("wakeLock" in navigator && !live.wake) live.wake = await navigator.wakeLock.request("screen"); } catch { /* egal */ }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && currentTab() === "live") { live.wake = null; requestWake(); }
});

/** Punkt im Tab „Live“, wenn gerade gefahren wird (auch in der Übersicht). */
async function pollLiveDot() {
  try {
    const r = await getJSON("/api/live");
    const on = r.data && r.data.state === "live" && r.age_s != null && r.age_s < LIVE_STALE_S;
    $("#tab-live-dot").hidden = !on;
  } catch { /* still */ }
}

/* --- Daten ----------------------------------------------------------------- */
function liveDriverParam() { return live.driver ? { driver: live.driver } : {}; }

function onLive(msg) {
  // Wer fährt? (leer = ich) – bei Wechsel Bestzeit und Runden des Fahrers laden
  const drv = msg.driver || msg.me || "";
  if (drv !== live.driver) {
    live.driver = drv; live.me = msg.me || ""; live.drvCurrent = msg.driver || "";
    renderDriverPick();
    if (live.combo) { live.pb = null; loadPb(); loadLaps(); }
  }
  live.age = msg.age_s;
  live.rxAt = performance.now();
  const d = msg.data;
  const prev = live.data;
  live.data = d;
  $("#tab-live-dot").hidden = !(d && d.state === "live" && msg.age_s < LIVE_STALE_S);
  if (!d || !d.game) { renderState(); if (typeof renderCockpit === "function") renderCockpit(); return; }

  const combo = { game: d.game, track: d.track, layout: d.layout || "", car: d.car };
  if (!live.combo || comboKey(live.combo) !== comboKey(combo)) {
    live.combo = combo; live.pb = null; live.geo = null; live.rows = new Set(); live.pbSectors = null; live.map = null; live.laps = []; live.coachId = null; $("#lv-coach-card").hidden = true; fuel.inputs = null;
    $("#lv-map").replaceChildren();
    loadPb();
    loadLaps();
  }
  // neue Runde / Session → Spur und Abschnitte zurücksetzen, Runden nachladen
  const key = `${d.session_uid}|${d.lap_count}`;
  if (key !== live.lapKey) {
    const lapDone = prev && prev.session_uid === d.session_uid && d.lap_count > prev.lap_count;
    live.lapKey = key; live.trail = []; live.bounds = []; live.lastRate = null;
    if (live.map) live.map.trail.replaceChildren();
    if (lapDone) { setTimeout(loadLaps, 2500); setTimeout(loadPb, 2500); }
  }
  if (d.state === "live" && !d.paused && d.current_ms > 0) addTrail(d);
  fuelOnLive(d);
  if (typeof ghostOnLive === "function") ghostOnLive(d, prev);
  render();
  if (typeof renderCockpit === "function") renderCockpit();
}

async function loadPb() {
  const c = live.combo;
  try {
    const traced = await getJSON(`/api/traces?${new URLSearchParams({ game: c.game, track: c.track, layout: c.layout, car: c.car, ...liveDriverParam() })}`);
    if (live.combo !== c) return;
    const counting = traced.filter(isCounting).sort((a, b) => a.lap_time_ms - b.lap_time_ms);
    const pb = counting[0] || null;
    // Streckenform: Server wählt die beste Quelle (Live-Aufzeichnung mit 1000 Punkten oder Runde)
    const tm = await getJSON(`/api/trackmap?${new URLSearchParams({ game: c.game, track: c.track, layout: c.layout, points: 1000 })}`).catch(() => ({}));
    let geo = tm.x ? { id: `trackmap:${tm.coverage}`, trace: tm, coverage: tm.coverage } : null;
    if (!geo) geo = [pb, ...traced].find((l) => l && l.trace.x && l.trace.x.filter((v) => v != null).length > 100) || null;
    const changed = !live.pb || !pb || live.pb.id !== pb.id;
    live.pb = pb;
    live.pbSectors = pb ? sectorTimes(pb) : null;
    renderLaps();
    if (changed || !live.map || (geo && (!live.geo || live.geo.id !== geo.id))) { live.geo = geo; buildLiveMap(geo); }
    render();
  } catch (e) { console.error(e); }
}

async function loadLaps() {
  const c = live.combo;
  try {
    const laps = await getJSON(`/api/laps?${comboQuery({ ...c }, liveDriverParam())}`.replace(/limit=\d+/, "limit=300"));
    if (live.combo !== c) return;
    live.laps = laps;
    renderLaps();
    loadLiveCoach();
    renderFuel();
  } catch (e) { console.error(e); }
}

/** Coach nach jeder Runde: neueste Runde dieser Session gegen die Bestzeit (Auto-Insights). */
async function loadLiveCoach() {
  const d = live.data, card = $("#lv-coach-card");
  const last = d && live.laps.filter((l) => l.session_uid && l.session_uid === d.session_uid && l.has_trace)
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
  if (!last) { card.hidden = true; live.coachId = null; return; }
  if (live.coachId === last.id) return;
  live.coachId = last.id;
  try {
    const r = await fetchInsights(last.id);
    if (live.coachId !== last.id) return;
    live.coachData = r;
    card.hidden = false;
    renderInsights($("#lv-coach"), r, { compact: true, combo: live.combo });
  } catch (e) { console.error(e); }
}

/** PB-Rundenzeit an Position npos (0..1), linear zwischen den Rasterpunkten. */
function pbAt(npos) {
  const t = live.pb && live.pb.trace.t;
  if (!t) return null;
  const n = t.length, f = npos * n, i = Math.floor(f);
  if (i >= n - 1) return t[n - 1] != null && npos <= 1 ? t[n - 1] + (live.pb.lap_time_ms - t[n - 1]) * (f - (n - 1)) : null;
  const a = t[i], b = t[i + 1];
  if (a == null || b == null) return null;
  return a + (b - a) * (f - i);
}
/** Tempo der Bestzeit an Position npos (km/h). */
function pbSpeedAt(npos) {
  const v = live.pb && live.pb.trace.v;
  if (!v) return null;
  const n = v.length, f = Math.min(n - 1.001, npos * n), i = Math.floor(f);
  const a = v[i], b = v[i + 1] ?? a;
  return a == null || b == null ? null : a + (b - a) * (f - i);
}
function liveDelta(d) {
  if (!d || d.current_ms <= 0 || d.npos == null) return null;
  if (d.npos > 0.97 && d.current_ms < 5000) return null;        // Wert der alten Runde hängt nach
  const p = pbAt(d.npos);
  return p == null ? null : d.current_ms - p;
}

function addTrail(d) {
  const last = live.trail[live.trail.length - 1];
  if (last && (d.npos <= last.npos || d.npos - last.npos < 0.002)) return;
  if (d.npos > 0.97 && d.current_ms < 5000) return;
  const pv = pbSpeedAt(d.npos);
  const pt = { npos: d.npos, t: d.current_ms, x: d.pos_x, z: d.pos_z, v: d.speed_kmh, delta: liveDelta(d),
               vd: pv != null && d.speed_kmh != null ? d.speed_kmh - pv : null };
  live.trail.push(pt);
  // Abschnittsgrenzen: Zeit beim Überfahren von k/10 interpolieren
  if (last) {
    for (let k = Math.ceil(last.npos * SECTORS); k <= Math.floor(pt.npos * SECTORS); k++) {
      const g = k / SECTORS;
      if (g <= last.npos || g > pt.npos || live.bounds[k] != null) continue;
      live.bounds[k] = last.t + (pt.t - last.t) * ((g - last.npos) / (pt.npos - last.npos));
    }
  } else if (d.npos < 0.02) live.bounds[0] = 0;
  if (live.map && last && last.x != null && pt.x != null) {
    // Farbe nach Tempo-Differenz zur Bestzeit (gemittelt über die letzten ~1 % der Runde)
    const back = live.trail.filter((p) => p.vd != null && pt.npos - p.npos <= 0.01);
    let color = "#8a8984";
    if (back.length) {
      const m = back.reduce((a, p) => a + p.vd, 0) / back.length;
      color = mixRgb(MAP_NEUTRAL, m < 0 ? MAP_LOSS : MAP_GAIN, Math.sqrt(Math.min(1, Math.abs(m) / 12)));
    }
    const P = live.map.P;
    const [x1, y1] = P(last.x, last.z), [x2, y2] = P(pt.x, pt.z);
    live.map.trail.append(s("line", { x1, y1, x2, y2, stroke: color }));
  }
}

/* --- Karte ----------------------------------------------------------------- */
function buildLiveMap(geo) {
  const box = $("#lv-map");
  live.map = null;
  if (!geo) {
    box.replaceChildren(h("p", { class: "analysis-empty" }, "Die Karte erscheint nach der ersten Runde mit Collector ab 0.3 (AC EVO, ACC, AC). Solange zeigt der Balken darunter die Position."));
    $("#lv-map-legend").replaceChildren();
    return;
  }
  const X = geo.trace.x, Z = geo.trace.z;
  const pts = X.map((x, i) => [x, Z[i]]).filter(([x, z]) => x != null && z != null);
  const W = box.clientWidth || 600, H = box.clientHeight || 340, pad = 24;
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const k = Math.min((W - 2 * pad) / Math.max(1, x1 - x0), (H - 2 * pad) / Math.max(1, z1 - z0));
  const ox = (W - (x1 - x0) * k) / 2, oz = (H - (z1 - z0) * k) / 2;
  const P = (x, z) => [+(ox + (x - x0) * k).toFixed(1), +(oz + (z - z0) * k).toFixed(1)];
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  let d = "";
  X.forEach((x, i) => {
    if (x == null || Z[i] == null) return;
    const [px, py] = P(x, Z[i]);
    d += `${i && X[i - 1] != null ? "L" : "M"}${px},${py}`;
  });
  svg.append(s("path", { class: "map-casing", d }), s("path", { class: "map-base", d }));
  // Start/Ziel
  const i0 = X.findIndex((x, i) => x != null && Z[i] != null);
  if (i0 >= 0 && i0 <= 2) {
    const [ax, ay] = P(X[i0], Z[i0]), [bx, by] = P(X[i0 + 2] ?? X[i0], Z[i0 + 2] ?? Z[i0]);
    let nx = -(by - ay), ny = bx - ax; const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
    svg.append(s("line", { class: "map-start", x1: ax - nx * 9, y1: ay - ny * 9, x2: ax + nx * 9, y2: ay + ny * 9 }));
  }
  const trail = s("g", { class: "map-segs lv-trail" });
  const dot = s("circle", { class: "map-dot lv-dot", r: 7, visibility: "hidden" });
  svg.append(trail, dot);
  box.replaceChildren(svg);
  live.map = { P, trail, dot, W, H };
  // bereits gesammelte Spur nachzeichnen
  const old = live.trail; live.trail = [];
  for (const p of old) addTrail({ npos: p.npos, current_ms: p.t, pos_x: p.x, pos_z: p.z, speed_kmh: p.v });
  $("#lv-map-legend").replaceChildren(...(!live.pb ? [h("span", { class: "key muted" }, "Noch keine Bestzeit zum Vergleich – die Spur ist grau, die Karte wächst beim Fahren mit.")] : [
    h("span", { class: "key" }, h("span", { class: "mark-loss" }), "langsamer"),
    h("span", { class: "key" }, h("span", { class: "mark-gain" }), "schneller"),
    h("span", { class: "key muted" }, "Tempo gegen die Bestzeit, volle Farbe ab ±12 km/h")]));
}

/* --- Darstellung ----------------------------------------------------------- */
function isStale() { return live.age == null || live.age + (performance.now() - live.rxAt) / 1000 > LIVE_STALE_S; }

function renderState() {
  const d = live.data, el = $("#lv-state");
  let cls = "off", txt = "Keine Verbindung zum Collector";
  if (!live.es) txt = "Verbinde …";
  else if (d && !isStale()) {
    if (d.state === "live" && !d.paused) { cls = "on"; txt = "Live"; }
    else if (d.state === "paused" || d.paused) { cls = "pause"; txt = "Pause / Replay"; }
    else if (d.state === "menu") { cls = "pause"; txt = "Im Menü"; }
    else if (d.state === "no_game") { cls = "off"; txt = "Kein Spiel aktiv – Collector wartet"; }
  } else if (d) txt = "Collector sendet nicht (PC aus oder Collector beendet)";
  el.className = `live-state ${cls}`;
  el.replaceChildren(h("span", { class: "dot" }), txt);
  if (!d || !d.game) { $("#lv-what").textContent = ""; $("#lv-sub").textContent = ""; }
}

function render() {
  renderState();
  const d = live.data;
  if (!d || !d.game) return;
  $("#lv-what").replaceChildren(trackName(d), " ", h("span", { class: "car" }, `· ${pretty(d.car)}`));
  $("#lv-sub").textContent = [gameName(d.game), SESSION_NAMES[d.session_type] || pretty(d.session_type), d.driver, d.online ? "online" : ""].filter(Boolean).join(" · ");

  $("#lv-lapno").textContent = `Runde ${d.lap_count + 1}`;
  const flags = [];
  if (d.in_pit_lane) flags.push(h("span", { class: "flag pit" }, "Boxengasse"));
  if (d.lap_outlap) flags.push(h("span", { class: "flag" }, "Outlap"));
  // Nur den festen Rundenstatus des Collectors zeigen – der Momentwert springt am Rundenanfang
  if (d.lap_invalid) flags.push(h("span", { class: "flag bad" }, h("b", {}, "✕"), " ungültig"));
  else if (d.valid_now != null) flags.push(h("span", { class: "flag ok" }, h("b", {}, "✓"), " gültig"));
  $("#lv-flags").replaceChildren(...flags);

  // Delta zur Bestzeit
  const delta = liveDelta(d), pb = live.pb;
  $("#lv-delta-label").textContent = pb ? `Abstand zur Bestzeit ${fmt(pb.lap_time_ms)}` : "Abstand zur Bestzeit";
  $("#lv-delta").textContent = delta == null ? "–" : `${fmtDelta(delta)}`;
  const mark = $("#lv-delta-mark");
  mark.className = `lv-delta-mark ${delta == null ? "" : delta > 0 ? "loss" : "gain"}`;
  mark.textContent = delta == null ? "" : delta > 0 ? "▼" : "▲";
  const bar = $("#lv-delta-bar");
  if (delta == null) bar.style.width = "0";
  else {
    const f = Math.min(1, Math.abs(delta) / 2000) * 50;            // ±2 s = volle Breite
    Object.assign(bar.style, { width: `${f}%`, left: delta > 0 ? "50%" : `${50 - f}%`, background: delta > 0 ? "var(--loss)" : "var(--gain)" });
  }
  $("#lv-pred").textContent = delta != null && pb ? `Prognose ${fmt(Math.round(pb.lap_time_ms + delta))}` : pb ? "" : "Noch keine gültige Runde mit Verlauf für diese Kombination.";

  renderLiveTiles(d);
  renderInputs(d);
  renderSectors(d);
  renderPosition(d);
  renderTele(d);
}

function renderLiveTiles(d) {
  const pb = live.pb;
  const sess = live.laps.filter((l) => l.session_uid && l.session_uid === d.session_uid);
  const sessBest = sess.filter(isCounting).sort((a, b) => a.lap_time_ms - b.lap_time_ms)[0];
  const last = d.last_ms > 0 ? d.last_ms : null;
  const tile = (label, value, sub) => h("div", { class: "insight" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), h("div", { class: "sub" }, sub || " "));
  $("#lv-tiles").replaceChildren(
    tile("Letzte Runde", last ? fmt(last) : "–", last && pb ? `${fmtDelta(last - pb.lap_time_ms)} s zur Bestzeit` : ""),
    tile("Beste dieser Session", sessBest ? fmt(sessBest.lap_time_ms) : "–", sessBest ? `Runde ${sessBest.lap_number ?? "?"} · ${sess.length} Runden` : `${sess.length} Runden`),
    tile("Bestzeit", pb ? fmt(pb.lap_time_ms) : "–", pb ? `gefahren ${fmtDate(pb.recorded_at)}` : "noch keine gültige"),
    tile("Bestzeit im Spiel", d.best_ms > 0 ? fmt(d.best_ms) : "–", "diese Session"),
  );
}

function renderInputs(d) {
  $("#lv-speed").textContent = d.speed_kmh == null ? "–" : Math.round(d.speed_kmh);
  // Beim Schalten meldet das Spiel kurz Leerlauf – in Fahrt „N“ erst nach 400 ms zeigen
  const now = performance.now();
  if (d.gear !== 0 || (d.speed_kmh || 0) < 15) { live.gearShown = d.gear; live.nSince = null; }
  else { live.nSince = live.nSince ?? now; if (now - live.nSince > 400) live.gearShown = 0; }
  const gr = live.gearShown;
  $("#lv-gear").textContent = gr == null ? "–" : gr < 0 ? "R" : gr === 0 ? "N" : String(gr);
  const rpmBar = $("#lv-rpm");
  rpmBar.parentElement.hidden = d.rpm_pct == null;
  if (d.rpm_pct != null) { rpmBar.style.width = `${Math.round(d.rpm_pct * 100)}%`; rpmBar.classList.toggle("hot", d.rpm_pct > 0.94); }
  if (d.rpm > 0) live.rpmTxt = `${d.rpm.toLocaleString(LOCALE)} U/min`;
  $("#lv-rpm-txt").textContent = live.rpmTxt || "";
  for (const [k, id] of [["throttle", "thr"], ["brake", "brk"]]) {
    const v = d[k];
    $(`#lv-${id}`).style.width = v == null ? "0" : `${Math.round(v * 100)}%`;
    $(`#lv-${id}-v`).textContent = v == null ? "–" : `${Math.round(v * 100)} %`;
  }
}

function renderSectors(d) {
  const box = $("#lv-sectors"), pbS = live.pbSectors;
  const cur = Math.min(SECTORS - 1, Math.floor((d.npos || 0) * SECTORS));
  const cells = [];
  let sum = 0, have = 0;
  for (let k = 0; k < SECTORS; k++) {
    const a = live.bounds[k], b = live.bounds[k + 1];
    let cls = "sec", val = "", title = `Abschnitt ${k + 1}`;
    if (a != null && b != null) {
      const t = b - a;
      if (pbS && pbS[k] != null) {
        const dd = t - pbS[k]; sum += dd; have++;
        cls += dd > 0 ? " loss" : " gain";
        val = `${dd > 0 ? "+" : "−"}${(Math.abs(dd) / 1000).toFixed(2)}`;
        title += `: ${(t / 1000).toFixed(3)} s, Bestzeit ${(pbS[k] / 1000).toFixed(3)} s`;
      } else { cls += " done"; val = (t / 1000).toFixed(1); }
    } else if (k === cur && d.state === "live") cls += " now";
    cells.push(h("div", { class: cls, title }, h("span", { class: "n" }, String(k + 1)), h("span", { class: "v" }, val)));
  }
  box.replaceChildren(...cells);
  $("#lv-sectors-sub").textContent = have ? `Summe der fertigen Abschnitte: ${sum > 0 ? "+" : "−"}${(Math.abs(sum) / 1000).toFixed(3)} s` : pbS ? "Rot langsamer, blau schneller als in der Bestzeit." : "";
}

function renderPosition(d) {
  $("#lv-progress").style.width = `${Math.max(0, Math.min(1, d.npos || 0)) * 100}%`;
  const m = live.map;
  if (!m) return;
  if (d.pos_x == null || d.pos_z == null) { m.dot.setAttribute("visibility", "hidden"); return; }
  const [x, y] = m.P(d.pos_x, d.pos_z);
  m.dot.setAttribute("cx", x); m.dot.setAttribute("cy", y); m.dot.setAttribute("visibility", "visible");
  const pv = pbSpeedAt(d.npos);
  if (!m.bubble) { m.bubble = s("g", { class: "map-hover" }); m.dot.parentNode.insertBefore(m.bubble, m.dot); }
  if (pv != null && d.speed_kmh != null && d.state === "live") {
    const dv = d.speed_kmh - pv;
    const ang = Math.atan2(y - m.H / 2, x - m.W / 2);
    m.bubble.replaceChildren(mapBubble([x, y], [Math.cos(ang), Math.sin(ang)], `${dv > 0.5 ? "+" : dv < -0.5 ? "−" : "±"}${Math.abs(Math.round(dv))} km/h`, "hover"));
  } else m.bubble.replaceChildren();
}

function renderLaps() {
  const d = live.data, box = $("#lv-laps");
  if (!d) return;
  const pb = live.pb;
  const sess = live.laps.filter((l) => l.session_uid && l.session_uid === d.session_uid)
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  if (!sess.length) { box.replaceChildren(h("p", { class: "analysis-empty" }, "Noch keine fertige Runde in dieser Session.")); return; }
  const best = sess.filter(isCounting).sort((a, b) => a.lap_time_ms - b.lap_time_ms)[0];
  const rows = sess.map((l) => h("tr", { class: isCounting(l) ? "" : "dim" },
    h("td", { class: "num" }, String(l.lap_number ?? "–")),
    h("td", { class: "num" }, fmt(l.lap_time_ms), best && l.id === best.id ? h("span", { class: "pb-star", title: "Beste dieser Session" }, " ★") : null),
    h("td", { class: "num" }, pb && isCounting(l) ? `${fmtDelta(l.lap_time_ms - pb.lap_time_ms)}` : "–"),
    h("td", {}, h("span", { class: "lv-badges" }, lapBadges(l, pb && pb.id)))));
  box.replaceChildren(h("table", { class: "lv-table" },
    h("thead", {}, h("tr", {}, h("th", { class: "num" }, "#"), h("th", { class: "num" }, "Zeit"), h("th", { class: "num" }, "zur PB"), h("th", {}, ""))),
    h("tbody", {}, rows)));
}

/* Laufende Uhr flüssig zwischen den Paketen weiterzählen */
function tick() {
  live.raf = requestAnimationFrame(tick);
  if (currentTab() !== "live") return;
  const d = live.data, el = $("#lv-time");
  if (!d || !d.game) { el.textContent = "–"; if (typeof tickCockpit === "function") tickCockpit(0); return; }
  let ms = d.current_ms;
  if (d.state === "live" && !d.paused && !isStale()) ms += Math.min(500, performance.now() - live.rxAt);
  el.textContent = ms > 0 ? fmt(Math.round(ms)) : "–";
  if (typeof tickCockpit === "function") tickCockpit(ms);
  if (performance.now() - (live.stateAt || 0) > 1000) { live.stateAt = performance.now(); renderState(); }
}

let liveResize;
window.addEventListener("resize", () => {
  clearTimeout(liveResize);
  liveResize = setTimeout(() => { if (currentTab() === "live" && live.geo) buildLiveMap(live.geo); }, 200);
});

setInterval(() => { if (!document.hidden && currentTab() !== "live") pollLiveDot(); }, 10000);
// Karte wächst beim Fahren: unvollständige Streckenform alle 20 s neu holen
setInterval(() => {
  if (document.hidden || currentTab() !== "live" || !live.combo) return;
  if (!live.geo || (live.geo.coverage != null && live.geo.coverage < 0.97)) loadPb();
}, 20000);

/* --- Wer fährt? ------------------------------------------------------------- */
async function renderDriverPick() {
  const el = $("#lv-driver");
  let names = state.drivers && state.drivers.length ? state.drivers : [];
  if (!names.length) { try { names = (await getJSON("/api/drivers")).drivers.map((d) => d.name).filter(Boolean); state.drivers = names; } catch { /* egal */ } }
  const me = live.me || state.me;
  const others = names.filter((n) => n && n !== me);
  el.replaceChildren(h("option", { value: "" }, me ? `Ich (${me})` : "Ich"), ...others.map((n) => h("option", { value: n }, n)), h("option", { value: "__neu__" }, "+ anderer Fahrer …"));
  el.value = live.drvCurrent || "";
  el.closest(".lv-driver").classList.toggle("guest", !!live.drvCurrent);
}
$("#lv-driver").addEventListener("change", async (e) => {
  let name = e.target.value;
  if (name === "__neu__") {
    name = (window.prompt("Wer fährt gerade? Neue Runden werden diesem Namen zugeordnet.") || "").trim();
    if (!name) { e.target.value = live.drvCurrent || ""; return; }
  }
  try {
    const r = await fetch("/api/drivers/current", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ driver: name }) });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    if (name && !state.drivers.includes(name)) state.drivers.push(name);
    live.drvCurrent = j.current; live.driver = j.current || j.me; live.me = j.me;
    renderDriverPick();
    if (live.combo) { live.pb = null; loadPb(); loadLaps(); }
  } catch (err) { alert(`Konnte Fahrer nicht setzen: ${err.message}`); renderDriverPick(); }
});
pollLiveDot();
showTab();

// ---------------------------------------------------------------------------
// Erweiterte Telemetrie (Collector ab 0.5): Verlauf, Reifen, G-Kräfte, Fahrhilfen, Motor
// ---------------------------------------------------------------------------
const TRACE_WINDOW_MS = 20000;
live.hist = [];          // { at, v, thr, brk }
live.gTrail = [];        // { at, x, y }

const COLD = [0x39, 0x87, 0xe5], HOT = [0xe6, 0x67, 0x67], OKC = [0x48, 0x48, 0x44];
/** Temperatur-/Druckfarbe: n = 1 ideal, < 1 kalt (blau), > 1 heiß (rot). */
function heatColor(n) {
  if (n == null || !isFinite(n)) return null;
  const d = n - 1;
  if (Math.abs(d) < 0.06) return mixRgb(OKC, OKC, 0);
  return mixRgb(OKC, d < 0 ? COLD : HOT, Math.min(1, (Math.abs(d) - 0.06) / 0.25));
}
const num = (v, nd = 0) => (v == null ? "–" : Number(v).toLocaleString(LOCALE, { minimumFractionDigits: nd, maximumFractionDigits: nd }));

function pushHist(d) {
  const now = performance.now();
  if (d.state === "live" && !d.paused) {
    live.hist.push({ at: now, v: d.speed_kmh, thr: d.throttle, brk: d.brake });
    const g = d.tele && d.tele.g;
    if (g && g[0] != null) live.gTrail.push({ at: now, x: g[0], y: g[1] });
  }
  while (live.hist.length && now - live.hist[0].at > TRACE_WINDOW_MS) live.hist.shift();
  while (live.gTrail.length && now - live.gTrail[0].at > 3000) live.gTrail.shift();
}

function renderTele(d) {
  pushHist(d);
  const t = d.tele || {};
  renderTrace();
  renderTyres(t);
  renderG(t);
  renderAssist(t);
  renderEngine(t, d);
}

function renderTrace() {
  const H = live.hist, now = performance.now();
  const leg = $("#lv-trace-legend");
  if (!leg.childElementCount) {
    const key = (c, l) => { const v = s("svg", { width: 18, height: 10 }); v.append(s("line", { x1: 1, y1: 5, x2: 17, y2: 5, stroke: c, "stroke-width": 2, "stroke-linecap": "round" })); return h("span", { class: "key" }, v, l); };
    leg.replaceChildren(key("var(--text-primary)", "Tempo"), key("var(--series-1)", "Gas"), key("var(--series-2)", "Bremse"));
  }
  const draw = (box, series, lo, hi, ticks, fmtY) => {
    const W = box.clientWidth || 600, Hh = box.clientHeight || 110, m = { l: 40, r: 6, t: 6, b: 4 };
    const x = (at) => m.l + (1 - (now - at) / TRACE_WINDOW_MS) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (Hh - m.t - m.b);
    const svg = s("svg", { viewBox: `0 0 ${W} ${Hh}`, "aria-hidden": "true" });
    const grid = s("g", { class: "grid" }), axis = s("g", { class: "axis" });
    for (const v of ticks) {
      grid.append(s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
      const tx = s("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }); tx.textContent = fmtY(v); axis.append(tx);
    }
    svg.append(grid, axis);
    for (const { key, color, scale = 1 } of series) {
      let dd = "", pen = false;
      for (const p of H) {
        const v = p[key];
        if (v == null) { pen = false; continue; }
        dd += `${pen ? "L" : "M"}${x(p.at).toFixed(1)},${y(v * scale).toFixed(1)}`; pen = true;
      }
      if (dd) svg.append(s("path", { d: dd, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round" }));
    }
    box.replaceChildren(svg);
  };
  const vs = H.map((p) => p.v).filter((v) => v != null);
  const vmax = Math.max(100, Math.ceil((Math.max(0, ...vs) + 10) / 50) * 50);
  const vt = []; for (let v = 0; v <= vmax; v += vmax > 200 ? 100 : 50) vt.push(v);
  draw($("#lv-trace-speed"), [{ key: "v", color: "var(--text-primary)" }], 0, vmax, vt, (v) => v);
  draw($("#lv-trace-pedals"), [{ key: "brk", color: "var(--series-2)", scale: 100 }, { key: "thr", color: "var(--series-1)", scale: 100 }], 0, 100, [0, 50, 100], (v) => `${v} %`);
}

function renderTyres(t) {
  const card = $("#lv-tyres-card");
  const has = t.tc || t.tp || t.bt;
  card.hidden = !has;
  if (!has) return;
  $("#lv-compound").textContent = t.compound ? `· ${t.compound}` : "";
  const names = ["VL", "VR", "HL", "HR"];
  // ohne normierte Werte vom Spiel: grobe GT3-Richtwerte (Reifenkern ~85 °C, Bremse ~450 °C)
  const tn = (k) => (t.tn && t.tn[k] ? t.tn[k] : t.tc && t.tc[k] ? t.tc[k] / 85 : null);
  const bn = (k) => (t.bn && t.bn[k] ? t.bn[k] : t.bt && t.bt[k] ? t.bt[k] / 450 : null);
  const faceN = (v, k) => (v == null ? null : t.tn && t.tc && t.tc[k] ? (v / t.tc[k]) * t.tn[k] : v / 85);
  const locked = names.map((_, k) => held(`lock${k}`, !!(t.lock && t.lock[k])));
  const cells = names.map((nm, k) => {
    const c = heatColor(tn(k));
    const faces = ["ti", "tm", "to"].map((f) => (t[f] ? t[f][k] : null));
    // Außenseite zeigt nach außen: links O|M|I, rechts I|M|O
    const order = k % 2 === 0 ? [2, 1, 0] : [0, 1, 2];
    const stripes = faces.some((v) => v) ? h("div", { class: "faces" }, order.map((j) => h("span", { style: `background:${heatColor(faceN(faces[j], k)) || "var(--surface-2)"}`, title: `${["innen", "mitte", "außen"][j]} ${num(faces[j])} °C` }))) : null;
    const bcol = heatColor(bn(k));
    return h("div", { class: `tyre${locked[k] ? " locked" : ""}`, style: c ? `--tc:${c}` : "" },
      h("div", { class: "tyre-head" }, h("span", { class: "nm" }, nm), h("span", { class: `lockb${locked[k] ? "" : " off"}` }, "blockiert")),
      h("div", { class: "temp" }, t.tc && t.tc[k] != null ? `${num(t.tc[k])}°` : "–"),
      stripes,
      h("div", { class: "row" }, h("span", {}, "Druck"), h("b", {}, t.tp && t.tp[k] != null ? `${num(t.tp[k], 1)} psi` : "–")),
      h("div", { class: "row" }, h("span", {}, h("i", { class: "bdot", style: bcol ? `background:${bcol}` : "" }), "Bremse"), h("b", {}, t.bt && t.bt[k] != null ? `${num(t.bt[k])} °C` : "–")));
  });
  $("#lv-tyres").replaceChildren(...cells);
  const leg = $("#lv-tyre-legend");
  if (!leg.childElementCount) leg.replaceChildren(
    h("span", { class: "key" }, h("span", { class: "mark-gain" }), "zu kalt"),
    h("span", { class: "key" }, h("span", { class: "mark-neutral" }), "im Fenster"),
    h("span", { class: "key" }, h("span", { class: "mark-loss" }), "zu heiß"),
    h("span", { class: "key muted" }, t.tn ? "laut Spiel" : "Richtwert GT3"));
}

function renderG(t) {
  const card = $("#lv-g-card"), g = t.g;
  card.hidden = !g || g[0] == null;
  if (card.hidden) return;
  const box = $("#lv-g"), S = 170, c = S / 2, R = S / 2 - 8, max = 2.5;
  const P = (gx, gy) => [c + Math.max(-1, Math.min(1, gx / max)) * R, c - Math.max(-1, Math.min(1, gy / max)) * R];
  const svg = s("svg", { viewBox: `0 0 ${S} ${S}`, "aria-hidden": "true" });
  for (const r of [1, 2]) svg.append(s("circle", { class: "ring", cx: c, cy: c, r: (r / max) * R }));
  svg.append(s("circle", { class: "ring outer", cx: c, cy: c, r: R }),
    s("line", { class: "axis-l", x1: c - R, x2: c + R, y1: c, y2: c }), s("line", { class: "axis-l", x1: c, x2: c, y1: c - R, y2: c + R }));
  for (const [r, lbl] of [[1, "1 G"], [2, "2 G"]]) { const tx = s("text", { x: c + 3, y: c - (r / max) * R + 10 }); tx.textContent = lbl; svg.append(tx); }
  const now = performance.now();
  live.gTrail.forEach((p, i) => {
    if (!i) return;
    const a = P(live.gTrail[i - 1].x, live.gTrail[i - 1].y), b = P(p.x, p.y);
    svg.append(s("line", { class: "gtrail", x1: a[0], y1: a[1], x2: b[0], y2: b[1], opacity: (1 - (now - p.at) / 3000).toFixed(2) }));
  });
  const [px, py] = P(g[0], g[1]);
  svg.append(s("circle", { class: "gdot", cx: px, cy: py, r: 7 }));
  box.replaceChildren(svg);
  const lat = g[0], lon = g[1];
  $("#lv-g-vals").replaceChildren(
    h("div", {}, h("span", {}, "quer"), h("b", {}, `${num(Math.abs(lat), 2)} G`)),
    h("div", {}, h("span", {}, lon < 0 ? "bremsen" : "Gas"), h("b", {}, `${num(Math.abs(lon), 2)} G`)));
}

function kv(label, value, extra, led) {
  return h("div", { class: `kv${extra ? " " + extra : ""}` },
    h("span", {}, led != null ? h("i", { class: `led${led ? " on" : ""}`, title: led ? "greift gerade" : "" }) : null, label),
    h("b", {}, value));
}

/** Kurze Ereignisse (ABS/TC greift, Rad blockiert) mindestens HOLD_MS anzeigen – sonst flackert es. */
const HOLD_MS = 800;
live.holdUntil = {};
function held(key, on) {
  const now = performance.now();
  if (on) live.holdUntil[key] = now + HOLD_MS;
  return (live.holdUntil[key] || 0) > now;
}

function renderAssist(t) {
  // Lenkung (in der Eingaben-Karte) unabhängig von den Fahrhilfen
  const st = t.steer, bar = $("#lv-steer");
  if (st == null) { bar.style.width = "0"; $("#lv-steer-txt").textContent = "–"; }
  else {
    const f = Math.min(1, Math.abs(st)) * 50;
    Object.assign(bar.style, { width: `${f}%`, left: st >= 0 ? "50%" : `${50 - f}%` });
    const deg = t.steer_deg != null ? t.steer_deg : Math.round(st * 100);
    $("#lv-steer-txt").textContent = `${deg < 0 ? "◀ " : deg > 0 ? "" : ""}${Math.abs(deg)}${t.steer_deg != null ? "°" : " %"}${deg > 0 ? " ▶" : ""}`;
  }
  const card = $("#lv-assist-card");
  const has = t.tc_lvl != null || t.abs_lvl != null || t.bb != null || t.abs_on != null;
  card.hidden = !has;
  if (!has) return;
  const items = [];
  const tcOn = held("tc", t.tc_on), absOn = held("abs", t.abs_on);
  if (t.tc_lvl != null) items.push(kv("TC", `${t.tc_lvl}${t.tc_cut ? ` · Cut ${t.tc_cut}` : ""}`, "", tcOn));
  if (t.abs_lvl != null) items.push(kv("ABS", String(t.abs_lvl), "", absOn));
  else if (t.abs_on != null) items.push(kv("ABS", absOn ? "greift" : "–", "", absOn));
  if (t.bb != null) items.push(kv("Bremsbalance", `${num(t.bb * 100, 1)} %`));
  if (t.map != null) items.push(kv("Motor-Map", String(t.map)));
  if (t.pit_lim) items.push(kv("Pit-Limiter", "an", "", true));
  $("#lv-assist").replaceChildren(...items);
}

/** Zeilen, die einmal Werte hatten, bleiben stehen (sonst springt die Liste beim Gaswegnehmen). */
live.rows = new Set();
function stickyRows(defs) {
  const items = [];
  for (const [key, label, val, show, extra] of defs) {
    if (show) live.rows.add(key);
    if (live.rows.has(key)) items.push(kv(label, show ? val : "–", show ? extra : ""));
  }
  return items;
}

function renderEngine(t, d) {
  const card = $("#lv-engine-card");
  if (d.rpm > 0) live.lastRpm = d.rpm;
  const fuelOk = t.fuel_lap > 0.3;                      // erst nach echter Messung (im Stand Unsinn)
  const dmg = (t.dmg || []).filter((v) => v != null);
  const items = stickyRows([
    ["water", "Wasser", `${num(t.water)} °C`, t.water > 0],
    ["oil", "Öl", `${num(t.oil)} °C`, t.oil > 0],
    ["oil_p", "Öldruck", `${num(t.oil_p, 1)} bar`, t.oil_p > 0],
    ["boost", "Ladedruck", `${num(Math.max(0, t.boost || 0), 2)} bar`, t.boost != null && (t.boost > 0.01 || live.rows.has("boost"))],
    ["bhp", "Leistung", `${num(Math.max(0, t.bhp || 0))} PS`, t.bhp != null && (t.bhp > 0 || live.rows.has("bhp"))],
    ["torque", "Drehmoment", `${num(Math.max(0, t.torque || 0))} Nm`, t.torque != null && (t.torque > 0 || live.rows.has("torque"))],
    ["rpm", "Drehzahl", `${num(live.lastRpm)} / ${num(t.max_rpm)}`, !!(t.max_rpm && live.lastRpm)],
    ["fuel", "Sprit", `${num(t.fuel, 1)} l`, t.fuel > 0],
    ["fuel_lap", "Verbrauch", `${num(t.fuel_lap, 2)} l/Runde`, fuelOk],
    ["fuel_laps", "reicht für", `${num(t.fuel_laps, 1)} Runden`, fuelOk && t.fuel_laps > 0, t.fuel_laps < 2 ? "warn" : ""],
    ["dmg", "Schaden", `${num(Math.max(0, ...dmg, 0) * 100)} %`, dmg.length > 0 && (Math.max(...dmg) > 0.01 || live.rows.has("dmg")), Math.max(0, ...dmg) > 0.01 ? "warn" : ""],
  ]);
  card.hidden = !items.length;
  $("#lv-engine").replaceChildren(...items);
}
