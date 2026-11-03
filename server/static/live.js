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

/* --- Tabs ------------------------------------------------------------------ */
function showTab() {
  const isLive = location.hash === "#live";
  $("#overview-view").hidden = isLive;
  $("#live-view").hidden = !isLive;
  for (const a of document.querySelectorAll(".tabs a")) {
    if ((a.dataset.tab === "live") === isLive) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  $("#tooltip").hidden = true;
  if (isLive) startLive(); else { stopLive(); if (live.wasLive) load(); }
  live.wasLive = isLive;
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
  if (!document.hidden && location.hash === "#live") { live.wake = null; requestWake(); }
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
function onLive(msg) {
  live.age = msg.age_s;
  live.rxAt = performance.now();
  const d = msg.data;
  const prev = live.data;
  live.data = d;
  $("#tab-live-dot").hidden = !(d && d.state === "live" && msg.age_s < LIVE_STALE_S);
  if (!d || !d.game) { renderState(); return; }

  const combo = { game: d.game, track: d.track, layout: d.layout || "", car: d.car };
  if (!live.combo || comboKey(live.combo) !== comboKey(combo)) {
    live.combo = combo; live.pb = null; live.geo = null; live.pbSectors = null; live.map = null; live.laps = [];
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
  render();
}

async function loadPb() {
  const c = live.combo;
  try {
    const traced = await getJSON(`/api/traces?${new URLSearchParams({ game: c.game, track: c.track, layout: c.layout, car: c.car })}`);
    if (live.combo !== c) return;
    const counting = traced.filter(isCounting).sort((a, b) => a.lap_time_ms - b.lap_time_ms);
    const pb = counting[0] || null;
    const geo = [pb, ...traced].find((l) => l && l.trace.x && l.trace.x.filter((v) => v != null).length > 100) || null;
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
    const laps = await getJSON(`/api/laps?${comboQuery({ ...c })}`.replace(/limit=\d+/, "limit=300"));
    if (live.combo !== c) return;
    live.laps = laps;
    renderLaps();
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
  const pt = { npos: d.npos, t: d.current_ms, x: d.pos_x, z: d.pos_z, delta: liveDelta(d) };
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
    // Farbe nach Verlust-Tempo über die letzten ~1,5 % der Runde
    const back = live.trail.filter((p) => p.delta != null && pt.npos - p.npos <= 0.03);
    let color = "#8a8984";
    if (pt.delta != null && back.length > 1) {
      const a = back[0], rate = (pt.delta - a.delta) / ((pt.npos - a.npos) / 0.005);   // ms je 0,5 %
      live.lastRate = rate;
      color = mixRgb(MAP_NEUTRAL, rate > 0 ? MAP_LOSS : MAP_GAIN, Math.min(1, Math.abs(rate) / 10));
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
  svg.append(s("path", { class: "map-base", d }));
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
  for (const p of old) addTrail({ npos: p.npos, current_ms: p.t, pos_x: p.x, pos_z: p.z });
  $("#lv-map-legend").replaceChildren(
    h("span", { class: "key" }, h("span", { class: "mark-loss" }), "verliert Zeit"),
    h("span", { class: "key" }, h("span", { class: "mark-gain" }), "gewinnt Zeit"),
    h("span", { class: "key muted" }, "gegen deine Bestzeit"));
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
  if (d.lap_invalid || d.valid_now === false) flags.push(h("span", { class: "flag bad" }, h("b", {}, "✕"), " ungültig"));
  else if (d.valid_now === true) flags.push(h("span", { class: "flag ok" }, h("b", {}, "✓"), " gültig"));
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

  renderTiles(d);
  renderInputs(d);
  renderSectors(d);
  renderPosition(d);
}

function renderTiles(d) {
  const pb = live.pb;
  const sess = live.laps.filter((l) => l.session_uid && l.session_uid === d.session_uid);
  const sessBest = sess.filter(isCounting).sort((a, b) => a.lap_time_ms - b.lap_time_ms)[0];
  const last = d.last_ms > 0 ? d.last_ms : null;
  const tile = (label, value, sub) => h("div", { class: "insight" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), h("div", { class: "sub" }, sub || " "));
  $("#lv-tiles").replaceChildren(
    tile("Letzte Runde", last ? fmt(last) : "–", last && pb ? `${fmtDelta(last - pb.lap_time_ms)} s zur Bestzeit` : ""),
    tile("Beste dieser Session", sessBest ? fmt(sessBest.lap_time_ms) : "–", sessBest ? `Runde ${sessBest.lap_number ?? "?"} · ${sess.length} Runden` : `${sess.length} Runden`),
    tile("Bestzeit", pb ? fmt(pb.lap_time_ms) : "–", pb ? `gefahren ${fmtDate(pb.recorded_at)}` : "noch keine gültige"),
    tile("Bestzeit im Spiel", d.best_ms > 0 ? fmt(d.best_ms) : "–", "laut Spiel, diese Session"),
  );
}

function renderInputs(d) {
  $("#lv-speed").textContent = d.speed_kmh == null ? "–" : Math.round(d.speed_kmh);
  $("#lv-gear").textContent = d.gear == null ? "–" : d.gear < 0 ? "R" : d.gear === 0 ? "N" : String(d.gear);
  const rpmBar = $("#lv-rpm");
  rpmBar.parentElement.hidden = d.rpm_pct == null;
  if (d.rpm_pct != null) { rpmBar.style.width = `${Math.round(d.rpm_pct * 100)}%`; rpmBar.classList.toggle("hot", d.rpm_pct > 0.94); }
  $("#lv-rpm-txt").textContent = d.rpm ? `${d.rpm.toLocaleString("de-DE")} U/min` : "";
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
  if (location.hash !== "#live") return;
  const d = live.data, el = $("#lv-time");
  if (!d || !d.game) { el.textContent = "–"; return; }
  let ms = d.current_ms;
  if (d.state === "live" && !d.paused && !isStale()) ms += Math.min(500, performance.now() - live.rxAt);
  el.textContent = ms > 0 ? fmt(Math.round(ms)) : "–";
  if (performance.now() - (live.stateAt || 0) > 1000) { live.stateAt = performance.now(); renderState(); }
}

let liveResize;
window.addEventListener("resize", () => {
  clearTimeout(liveResize);
  liveResize = setTimeout(() => { if (location.hash === "#live" && live.geo) buildLiveMap(live.geo); }, 200);
});

setInterval(() => { if (!document.hidden && location.hash !== "#live") pollLiveDot(); }, 10000);
pollLiveDot();
showTab();
