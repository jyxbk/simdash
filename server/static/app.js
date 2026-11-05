"use strict";

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const SVGNS = "http://www.w3.org/2000/svg";

const GAME_NAMES = { acevo: "AC EVO", acc: "ACC", ac: "Assetto Corsa", acrally: "AC Rally", iracing: "iRacing" };
const GAME_ORDER = ["acevo", "iracing", "acc", "acrally", "ac"];
const SESSION_NAMES = {
  practice: "Training", qualify: "Qualifying", race: "Rennen", hotlap: "Hotlap",
  time_attack: "Time Attack", hot_stint: "Hot Stint", cruise: "Cruise", superpole: "Superpole",
  time_trial: "Time Trial", testing: "Testfahrt", warmup: "Warm-up",
};

/** DOM bauen; Strings werden immer als Text eingefügt (Spieldaten sind nicht vertrauenswürdig). */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function s(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const UPPER = new Set(["bmw", "amg", "gt", "gtr", "gte", "lmp", "lmh", "lmdh", "ks", "gp"]);
function pretty(id) {
  if (!id) return "";
  if (/[A-Z ]/.test(id)) return String(id);   // schon ein Anzeigename (iRacing, AC EVO)
  return String(id).replace(/^ks_/, "").replace(/[_-]+/g, " ").split(" ")
    .map((w) => (/\d/.test(w) || UPPER.has(w.toLowerCase())) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
const trackName = (x) => pretty(x.track) + (x.layout ? ` · ${pretty(x.layout)}` : "");
const gameName = (g) => GAME_NAMES[g] || g;

function fmt(ms) {
  if (ms == null) return "–";
  const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${m}:${String(sec).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
}
const fmtDelta = (ms) => `${ms < 0 ? "−" : "+"}${(Math.abs(ms) / 1000).toFixed(3)}`;

function fmtDate(iso) {
  return new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `vor ${hours} h`;
  const d = Math.round(hours / 24);
  return d === 1 ? "gestern" : `vor ${d} Tagen`;
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

const comboKey = (x) => [x.game, x.track, x.layout, x.car].join("␟");
const isCounting = (l) => l.valid !== false && !l.estimated;   // zählt für die Bestzeit
const driverParam = () => (state.driver && state.driver !== ALL_DRIVERS ? { driver: state.driver } : {});
const comboQuery = (c, extra = driverParam()) => new URLSearchParams({ game: c.game, track: c.track, layout: c.layout, car: c.car, limit: 5000, ...extra });

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------
const state = { game: "", track: "", car: "", driver: null, me: "", drivers: [], selected: null, laps: [], bests: [], detail: null, sessionsShown: 5 };
const ALL_DRIVERS = "__alle__";

function query(extra = {}) {
  const p = new URLSearchParams();
  for (const k of ["game", "track", "car"]) if (state[k]) p.set(k, state[k]);
  if (state.driver && state.driver !== ALL_DRIVERS) p.set("driver", state.driver);
  for (const [k, v] of Object.entries(extra)) if (v != null) p.set(k, v);
  return p.toString();
}

// ---------------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------------
/** Runden, die für ihre Kombination eine neue Bestzeit gesetzt haben (chronologisch). */
function pbEvents(laps) {
  const chrono = [...laps].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const best = new Map();
  const events = [];
  for (const l of chrono) {
    if (!isCounting(l)) continue;
    const k = comboKey(l);
    const prev = best.get(k);
    if (prev == null || l.lap_time_ms < prev) {
      events.push({ lap: l, prev });
      best.set(k, l.lap_time_ms);
    }
  }
  return events;
}

function groupSessions(laps) {
  const map = new Map();
  for (const l of laps) {
    const k = l.session_uid || comboKey(l);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(l);
  }
  return [...map.values()]
    .map((ls) => ls.sort((a, b) => (a.lap_number ?? 0) - (b.lap_number ?? 0) || a.recorded_at.localeCompare(b.recorded_at)))
    .sort((a, b) => b[b.length - 1].recorded_at.localeCompare(a[a.length - 1].recorded_at));
}

// ---------------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------------
function renderStatus(stats) {
  const box = $("#status");
  box.replaceChildren();
  if (!stats.last_lap) return;
  const live = Date.now() - new Date(stats.last_lap) < 15 * 60000;
  box.append(h("span", { class: `dot${live ? " live" : ""}` }), `letzte Runde ${ago(stats.last_lap)}`);
}

function renderChips(games) {
  const list = ["", ...GAME_ORDER.filter((g) => games.includes(g)), ...games.filter((g) => !GAME_ORDER.includes(g))];
  $("#game-chips").replaceChildren(...list.map((g) => h("button", {
    class: "chip", type: "button", "aria-pressed": String(state.game === g),
    onclick: () => { Object.assign(state, { game: g, track: "", car: "" }); load(); },
  }, g ? gameName(g) : "Alle")));
}

function fillSelect(el, values, label, key) {
  el.replaceChildren(h("option", { value: "" }, label), ...values.map((v) => h("option", { value: v }, pretty(v))));
  el.value = values.includes(state[key]) ? state[key] : "";
}

function renderHero(laps) {
  const box = $("#hero");
  const events = pbEvents(laps);
  const ev = events[events.length - 1];
  if (!ev) {
    box.replaceChildren($("#tpl-empty").content.cloneNode(true));
    return;
  }
  const l = ev.lap;
  const history = events.slice(-6, -1).reverse();
  box.replaceChildren(h("div", { class: "hero-main" },
    h("div", { class: "label" }, "Neueste Bestzeit"),
    h("div", { class: "value" }, fmt(l.lap_time_ms)),
    h("div", { class: "what" }, trackName(l)),
    h("div", { class: "sub" }, `${pretty(l.car)} · ${gameName(l.game)} · ${fmtDate(l.recorded_at)}`),
    h("div", { class: "delta" },
      ev.prev != null
        ? [h("span", { class: "delta-good" }, `▲ ${fmtDelta(l.lap_time_ms - ev.prev)} s`), ` schneller als die alte Bestzeit ${fmt(ev.prev)}`]
        : "Erste gültige Runde mit diesem Auto auf dieser Strecke"),
  ), history.length ? h("div", { class: "hero-side" },
    h("div", { class: "label" }, "Davor"),
    h("ol", { class: "pb-list" }, history.map((e) => h("li", {},
      h("span", { class: "t" }, fmt(e.lap.lap_time_ms)),
      h("span", { class: "w" }, `${trackName(e.lap)} · ${pretty(e.lap.car)}`),
      h("span", { class: "d" }, e.prev != null ? h("span", { class: "delta-good" }, `▲ ${fmtDelta(e.lap.lap_time_ms - e.prev)}`) : "erste"),
    )))) : null);
}

function renderTiles(st) {
  const tile = (label, value, sub) => h("div", { class: "tile" },
    h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null);
  $("#tiles").replaceChildren(
    tile("Runden", st.laps.toLocaleString("de-DE"), `${st.valid_laps ?? 0} gültig`),
    tile("Strecken", st.tracks, `${st.sessions} Sessions`),
    tile("Autos", st.cars, `in ${st.games} ${st.games === 1 ? "Spiel" : "Spielen"}`),
    tile("Fahrzeit", fmtDuration(st.drive_ms), "auf der Strecke"),
  );
}

/** Mini-Verlauf der gültigen Runden; eine Serie, daher ohne Legende. Bestzeit = grüner Punkt. */
function sparkline(laps) {
  const pts = laps.filter(isCounting).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at)).slice(-24);
  const svg = s("svg", { class: "spark", viewBox: "0 0 300 38", preserveAspectRatio: "none", "aria-hidden": "true" });
  if (pts.length < 2) return h("div", { class: "spark-empty" }, "Verlauf ab 2 gültigen Runden");
  const ys = pts.map((l) => l.lap_time_ms);
  const min = Math.min(...ys), max = Math.max(...ys), span = Math.max(max - min, 1);
  const x = (i) => 6 + (i / (pts.length - 1)) * 288;
  const y = (v) => 6 + ((v - min) / span) * 26;           // oben = schneller
  const d = pts.map((l, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(l.lap_time_ms).toFixed(1)}`).join("");
  svg.append(s("path", { d, fill: "none", stroke: "var(--series-1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" }));
  return svg;
}

function renderBests(bests, laps) {
  const box = $("#bests");
  if (!bests.length) { box.replaceChildren(); return; }
  const byCombo = new Map();
  for (const l of laps) {
    const k = comboKey(l);
    if (!byCombo.has(k)) byCombo.set(k, []);
    byCombo.get(k).push(l);
  }
  box.replaceChildren(...bests.map((c) => {
    const v = c.best_valid;
    const key = comboKey(c);
    return h("button", {
      class: "card", type: "button", "aria-current": String(state.selected === key),
      "aria-label": `${trackName(c)}, ${pretty(c.car)}, Bestzeit ${v ? fmt(v.lap_time_ms) : "keine"}. Details öffnen`,
      onclick: () => openDetail(c),
    },
      h("div", { class: "card-top" },
        h("div", {}, h("div", { class: "track" }, trackName(c)), h("div", { class: "car" }, pretty(c.car))),
        h("span", { class: "game" }, gameName(c.game))),
      h("div", { class: "time" }, v ? fmt(v.lap_time_ms) : "–:––.–––"),
      sparkline(byCombo.get(key) || []),
      h("div", { class: "potential", "data-combo": key }, potentialText(c)),
      h("div", { class: "meta" },
        h("span", {}, `${c.laps} ${c.laps === 1 ? "Runde" : "Runden"}`),
        h("span", {}, v ? `Bestzeit ${fmtDate(v.recorded_at)}` : "noch keine gültige Runde")),
    );
  }));
}

/* Potenzial je Kombination für die Karten (Coach-Ergebnis, zwischengespeichert bis neue Runden kommen) */
const potentialCache = new Map();
function potentialText(c) {
  const ck = `${comboKey(c)}|${state.driver}|${c.laps}`;
  const hit = potentialCache.get(ck);
  if (hit === undefined) {
    potentialCache.set(ck, null);
    getJSON(`/api/coach?${new URLSearchParams({ game: c.game, track: c.track, layout: c.layout, car: c.car, ...driverParam() })}`)
      .then((d) => {
        potentialCache.set(ck, d);
        const el = document.querySelector(`.card .potential[data-combo="${CSS.escape(comboKey(c))}"]`);
        if (el) el.replaceChildren(...[potentialText(c)].flat());
      }).catch(() => {});
    return "";
  }
  if (!hit || hit.potential_ms == null) return "";
  const top = hit.corners.filter((x) => x.gain_ms >= 30).sort((a, b) => b.gain_ms - a.gain_ms)[0];
  if (!top) return "Coach: in jeder Kurve schon am Limit";
  return [h("b", {}, `−${(hit.potential_ms / 1000).toFixed(2)} s`), ` Potenzial · v. a. Kurve ${top.no}`];
}

function lapBadges(l, pbId) {
  return [
    l.id === pbId ? h("span", { class: "badge pb" }, "★ PB") : null,
    l.valid === false ? h("span", { class: "badge bad" }, "✕ ungültig") : null,
    l.estimated ? h("span", { class: "badge warn", title: "Zeit aus der laufenden Uhr an der Ziellinie (Rundenzähler fehlte)" }, "≈ geschätzt") : null,
    l.outlap ? h("span", { class: "badge" }, "Outlap") : null,
    l.inlap ? h("span", { class: "badge" }, "Inlap") : null,
    l.driver && state.me && l.driver !== state.me ? h("span", { class: "badge driver" }, l.driver) : null,
  ];
}

function renderSessions(laps, bests) {
  const box = $("#sessions");
  const pbByCombo = new Map(bests.map((c) => [comboKey(c), c.best_valid]));
  const sessions = groupSessions(laps);
  if (!sessions.length) { box.replaceChildren(); return; }
  const shown = sessions.slice(0, state.sessionsShown);
  state.openSessions = state.openSessions || new Set();
  box.replaceChildren(...shown.map((ls, idx) => {
    const first = ls[0], last = ls[ls.length - 1];
    const pb = pbByCombo.get(comboKey(first));
    const counting = ls.filter(isCounting);
    const sBest = counting.length ? Math.min(...counting.map((l) => l.lap_time_ms)) : null;
    const rows = ls.map((l) => h("tr", { class: l.valid === false ? "invalid" : "" },
      h("td", { class: "lapno num" }, l.lap_number ?? ""),
      h("td", { class: "t num" }, fmt(l.lap_time_ms)),
      h("td", { class: "delta num hide-sm" },
        pb && isCounting(l) ? (l.id === pb.id ? "" : fmtDelta(l.lap_time_ms - pb.lap_time_ms)) : ""),
      h("td", {}, lapBadges(l, pb && pb.id), l.note ? h("span", { class: "note" }, ` ${l.note}`) : null),
    ));
    const sk = first.session_uid || comboKey(first) + first.recorded_at;
    const open = state.openSessions.has(sk) || (idx === 0 && !state.openSessions.has(`closed:${sk}`));
    const det = h("details", { class: "session", open: open || null },
      h("summary", { class: "session-head" },
        h("div", {},
          h("div", { class: "what" }, trackName(first), " ", h("span", { class: "car" }, `· ${pretty(first.car)}`)),
          h("div", { class: "info" },
            `${gameName(first.game)} · ${SESSION_NAMES[first.session_type] || first.session_type || "Session"}${first.online ? " · online" : ""} · ${fmtDate(last.recorded_at)} · ${ls.length} ${ls.length === 1 ? "Runde" : "Runden"}`)),
        h("div", { class: "session-side" },
          h("div", { class: "session-best" }, "Beste Runde ", h("b", {}, sBest ? fmt(sBest) : "–")),
          h("button", { class: "driver-btn", type: "button", title: "Bericht zu dieser Session",
            onclick: (e) => { e.preventDefault(); e.stopPropagation(); showSessionReport(ls); } }, "Bericht"),
          h("button", { class: "driver-btn", type: "button", title: "Fahrer dieser Session ändern",
            onclick: (e) => { e.preventDefault(); e.stopPropagation(); openDriverDialog(ls, `Wer ist diese Session gefahren? · ${trackName(first)}`); } },
            "✎ ", first.driver && first.driver !== state.me ? first.driver : "Ich"))),
      h("table", {},
        h("thead", {}, h("tr", {},
          h("th", { class: "num lapno" }, "#"), h("th", { class: "num tcol" }, "Zeit"),
          h("th", { class: "num dcol hide-sm" }, "zur PB"), h("th", {}, ""))),
        h("tbody", {}, rows)),
    );
    det.addEventListener("toggle", () => {
      if (det.open) { state.openSessions.add(sk); state.openSessions.delete(`closed:${sk}`); }
      else { state.openSessions.delete(sk); state.openSessions.add(`closed:${sk}`); }
    });
    return det;
  }));
  if (sessions.length > shown.length) {
    box.append(h("button", {
      class: "more", type: "button",
      onclick: () => { state.sessionsShown += 5; renderSessions(state.laps, state.bests); },
    }, `Weitere Sessions anzeigen (${sessions.length - shown.length})`));
  }
}

// ---------------------------------------------------------------------------
// Detail: Rundenzeiten-Diagramm (eine Serie, Crosshair + Tooltip, Tabelle)
// ---------------------------------------------------------------------------
/** Kombination in der Analyse öffnen (wechselt in den Analyse-Tab). */
function openDetail(c) {
  state.selected = comboKey(c);
  if (currentTab() !== "analyse") location.hash = "#analyse";   // showTab → openAnalyse
  else openAnalyse();
  window.scrollTo({ top: 0 });
}

/** Analyse-Tab zeigen: Auswahl füllen, gewählte (oder zuletzt gefahrene) Kombination laden. */
async function openAnalyse() {
  const sel = $("#a-combo");
  const bests = state.bests || [];
  const empty = $("#analyse-empty");
  const hasData = bests.length > 0;
  empty.hidden = hasData;
  for (const id of ["#coach", "#analysis", "#laptimes", ".an-head", ".an-row"]) $(id).hidden = !hasData;
  if (!hasData) {
    empty.replaceChildren(h("p", { class: "analysis-empty" }, state.loaded ? "Mit diesen Filtern gibt es keine Runden. Wähle oben ein anderes Spiel oder „Alle“." : "Lädt …"));
    return;
  }
  let c = bests.find((b) => comboKey(b) === state.selected);
  if (!c) { c = bests[0]; state.selected = comboKey(c); }
  sel.replaceChildren(...bests.map((b) => h("option", { value: comboKey(b) },
    `${trackName(b)} · ${pretty(b.car)} · ${gameName(b.game)}${b.best_valid ? " · " + fmt(b.best_valid.lap_time_ms) : ""}`)));
  sel.value = state.selected;
  $("#detail-title").textContent = `${trackName(c)} · ${pretty(c.car)} · ${gameName(c.game)} · ${c.laps} ${c.laps === 1 ? "Runde" : "Runden"}`;
  renderLegend();
  await refreshDetail(c);
}
$("#a-combo").addEventListener("change", (e) => { state.selected = e.target.value; openAnalyse(); renderBests(state.bests, state.laps); });
for (const a of document.querySelectorAll("[data-jump]")) {
  a.addEventListener("click", (e) => { e.preventDefault(); $(`#${a.dataset.jump}`).scrollIntoView({ behavior: "smooth", block: "start" }); });
}

async function refreshDetail(c) {
  const laps = (await getJSON(`/api/laps?${comboQuery(c)}`)).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  // Nur neu zeichnen, wenn sich etwas geändert hat (läuft alle 15 s mit)
  const sig = [comboKey(c), state.driver, laps.length, laps.length && laps[laps.length - 1].id, laps.map((l) => `${l.driver}${l.valid}`).join()].join("|");
  if (state.detailSig === sig) return;
  state.detailSig = sig;
  state.detail = { laps, pb: c.best_valid };
  drawChart(laps, c.best_valid);
  renderDetailTable(laps, c.best_valid);
  const keepSel = analysis.c && comboKey(analysis.c) === comboKey(c) ? [$("#pick-lap").value, $("#pick-ref").value] : null;
  renderProgress();
  loadNotes(c);
  await loadAnalysis(c);
  loadCoach(c);
  if (keepSel && analysis.traced.some((l) => String(l.id) === keepSel[0]) && analysis.traced.some((l) => String(l.id) === keepSel[1])) {
    [$("#pick-lap").value, $("#pick-ref").value] = keepSel;
    renderAnalysis();
  }
}

function renderLegend() {
  const line = () => { const v = s("svg", { width: 18, height: 10 }); v.append(s("line", { x1: 1, y1: 5, x2: 17, y2: 5, stroke: "var(--series-1)", "stroke-width": 2, "stroke-linecap": "round" })); return v; };
  const dot = (attrs) => { const v = s("svg", { width: 12, height: 12 }); v.append(s("circle", { cx: 6, cy: 6, r: 4, ...attrs })); return v; };
  $("#detail-legend").replaceChildren(
    h("span", { class: "key" }, line(), "gültige Runden"),
    h("span", { class: "key" }, dot({ fill: "var(--good)" }), "★ Bestzeit"),
    h("span", { class: "key" }, dot({ fill: "var(--surface-1)", stroke: "var(--text-muted)", "stroke-width": 1.5 }), "ungültig / geschätzt"),
  );
}

function drawChart(laps, pb) {
  const box = $("#chart");
  box.replaceChildren();
  if (!laps.length) return;
  const W = box.clientWidth || 600, H = box.clientHeight || 260;
  const m = { l: 58, r: 14, t: 18, b: 26 };
  const counting = laps.filter(isCounting);
  const ys = (counting.length ? counting : laps).map((l) => l.lap_time_ms).sort((a, b) => a - b);
  // Ausreißer (Dreher, Boxenrunden) bestimmen nicht die Skala; sie sitzen am unteren Rand
  const lo = ys[0], hi = ys[Math.min(ys.length - 1, Math.floor(ys.length * 0.9))];
  const pad = Math.max((hi - lo) * 0.15, 250);
  const yMin = lo - pad, yMax = hi + pad;
  const n = laps.length;
  const x = (i) => m.l + (n === 1 ? (W - m.l - m.r) / 2 : (i / (n - 1)) * (W - m.l - m.r));
  const y = (v) => m.t + ((Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * (H - m.t - m.b);

  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  box.setAttribute("aria-label", `Rundenzeiten: ${n} Runden, Bestzeit ${pb ? fmt(pb.lap_time_ms) : "keine"}. Werte auch in der Tabelle.`);

  // Raster und Achse – schneller ist oben
  const grid = s("g", { class: "grid" }), axis = s("g", { class: "axis" });
  // runde Schrittweite (0,1 s, 0,25 s, 0,5 s, 1 s …), etwa 4–6 Linien
  const steps = [100, 200, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
  const step = steps.find((st) => (yMax - yMin) / st <= 6) || 60000;
  const decimals = step < 1000 ? (step % 100 ? 2 : 1) : 0;
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
    const yy = y(v);
    grid.append(s("line", { x1: m.l, x2: W - m.r, y1: yy, y2: yy }));
    const t = s("text", { x: m.l - 8, y: yy + 4, "text-anchor": "end" });
    t.textContent = fmt(v).slice(0, decimals ? -(3 - decimals) : -4);
    axis.append(t);
  }
  const note = s("text", { x: m.l, y: H - 6 });
  note.textContent = "Runden nacheinander →     oben = schneller";
  axis.append(note);
  svg.append(grid, axis, s("line", { class: "baseline", x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));

  if (pb) {
    const py = y(pb.lap_time_ms);
    svg.append(s("line", { class: "pbline", x1: m.l, x2: W - m.r, y1: py, y2: py }));
    const t = s("text", { class: "pblabel", x: W - m.r, y: py - 7, "text-anchor": "end" });
    t.textContent = `★ PB ${fmt(pb.lap_time_ms)}`;
    svg.append(t);
  }

  const idx = laps.map((l, i) => [l, i]);
  const path = idx.filter(([l]) => isCounting(l)).map(([l, i], k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(l.lap_time_ms).toFixed(1)}`).join("");
  if (path) svg.append(s("path", { class: "line", d: path }));
  for (const [l, i] of idx) {
    const isPb = pb && l.id === pb.id;
    svg.append(s("circle", { class: !isCounting(l) ? "dot invalid" : isPb ? "dot pb" : "dot", cx: x(i), cy: y(l.lap_time_ms), r: isPb ? 6 : 4 }));
  }

  // Crosshair + Tooltip: rastet auf die nächste Runde ein; Tastatur mit ← →
  const cross = s("line", { class: "crosshair", y1: m.t, y2: H - m.b, visibility: "hidden" });
  const ring = s("circle", { r: 8, fill: "none", stroke: "var(--text-primary)", "stroke-width": 2, visibility: "hidden" });
  const hit = s("rect", { x: m.l - 12, y: 0, width: W - m.l - m.r + 24, height: H, fill: "transparent", tabindex: 0, "aria-label": "Runden mit Pfeiltasten durchgehen" });
  svg.append(cross, ring, hit);
  box.append(svg);

  const tip = $("#tooltip");
  let cur = n - 1;
  const show = (i, clientX, clientY) => {
    cur = i;
    const l = laps[i], cx = x(i), cy = y(l.lap_time_ms);
    for (const [el, a, v] of [[cross, "x1", cx], [cross, "x2", cx], [ring, "cx", cx], [ring, "cy", cy]]) el.setAttribute(a, v);
    cross.setAttribute("visibility", "visible"); ring.setAttribute("visibility", "visible");
    tip.replaceChildren(...[
      h("div", { class: "v" }, fmt(l.lap_time_ms)),
      h("div", { class: "k" }, h("i"), `Runde ${l.lap_number ?? "?"} · ${fmtDate(l.recorded_at)}`),
      pb && isCounting(l) && l.id !== pb.id ? h("div", { class: "k" }, `${fmtDelta(l.lap_time_ms - pb.lap_time_ms)} s zur PB`) : null,
      h("div", {}, lapBadges(l, pb && pb.id)),
      l.note ? h("div", { class: "k" }, l.note) : null,
    ].filter(Boolean));
    tip.hidden = false;
    const r = box.getBoundingClientRect();
    const px = clientX ?? r.left + (cx / W) * r.width, py = clientY ?? r.top + (cy / H) * r.height;
    tip.style.left = `${Math.min(Math.max(8, px + 14), window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(8, py - tip.offsetHeight - 14)}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); ring.setAttribute("visibility", "hidden"); };
  const nearest = (clientX) => {
    const r = box.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    laps.forEach((_, i) => { const d = Math.abs(x(i) - sx); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  hit.addEventListener("pointermove", (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  hit.addEventListener("pointerdown", (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
  hit.addEventListener("focus", () => show(cur));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { show(Math.max(0, cur - 1)); e.preventDefault(); }
    if (e.key === "ArrowRight") { show(Math.min(n - 1, cur + 1)); e.preventDefault(); }
    if (e.key === "Escape") hide();
  });
}

function renderDetailTable(laps, pb) {
  const rows = [...laps].reverse().map((l) => h("tr", { class: l.valid === false ? "invalid" : "" },
    h("td", {}, fmtDate(l.recorded_at)),
    h("td", { class: "num" }, l.lap_number ?? ""),
    h("td", { class: "t num" }, fmt(l.lap_time_ms)),
    h("td", { class: "num hide-sm" }, pb && isCounting(l) && l.id !== pb.id ? fmtDelta(l.lap_time_ms - pb.lap_time_ms) : ""),
    h("td", {}, lapBadges(l, pb && pb.id), l.note ? h("span", { class: "note" }, ` ${l.note}`) : null),
  ));
  $("#detail-table").replaceChildren(
    h("button", { class: "driver-btn", type: "button", onclick: () => openDriverDialog([...laps].reverse(), "Runden einem Fahrer zuordnen") }, "✎ Fahrer zuordnen"),
    h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Wann"), h("th", { class: "num" }, "#"), h("th", { class: "num" }, "Zeit"), h("th", { class: "num hide-sm" }, "zur PB"), h("th", {}, ""))),
    h("tbody", {}, rows)));
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------
async function load() {
  document.body.classList.add("loading");
  try {
    if (state.driver == null) {
      const dr = await getJSON("/api/drivers");
      Object.assign(state, { me: dr.me, driver: dr.me || ALL_DRIVERS });
    }
    const q = query();
    const [f, st, bests, laps] = await Promise.all([
      getJSON("/api/filters"), getJSON(`/api/stats?${q}`), getJSON(`/api/bests?${q}`), getJSON(`/api/laps?${query({ limit: 2000 })}`),
    ]);
    Object.assign(state, { bests, laps, loaded: true });
    renderChips(f.games);
    fillSelect($("#f-track"), f.tracks, "Alle Strecken", "track");
    fillSelect($("#f-car"), f.cars, "Alle Autos", "car");
    renderDriverSelect(f.drivers || []);
    renderStatus(st);
    renderHero(laps);
    renderTiles(st);
    renderBests(bests, laps);
    renderSessions(laps, bests);
    renderReport();
    if (currentTab() === "analyse") await openAnalyse();
  } catch (e) {
    $("#status").textContent = "Server nicht erreichbar";
    console.error(e);
  } finally {
    document.body.classList.remove("loading");
  }
}

$("#f-track").addEventListener("change", (e) => { state.track = e.target.value; load(); });
$("#f-car").addEventListener("change", (e) => { state.car = e.target.value; load(); });
$("#f-driver").addEventListener("change", (e) => { state.driver = e.target.value; load(); });

function renderDriverSelect(names) {
  state.drivers = names.filter(Boolean);
  const others = state.drivers.filter((n) => n !== state.me);
  const el = $("#f-driver");
  el.replaceChildren(
    h("option", { value: state.me || ALL_DRIVERS }, state.me ? `Ich (${state.me})` : "Ich"),
    ...others.map((n) => h("option", { value: n }, n)),
    h("option", { value: ALL_DRIVERS }, "Alle Fahrer"));
  el.value = state.driver;
  el.parentElement.hidden = !others.length && state.driver !== ALL_DRIVERS && !names.includes("");
}

/* --- Fahrer zuordnen (Session oder einzelne Runden) ------------------------- */
function openDriverDialog(laps, title) {
  const dlg = $("#driver-dialog");
  const cur = laps[0].driver || "";
  $("#dd-title").textContent = title;
  $("#dd-name").value = cur;
  $("#dd-names").replaceChildren(...[...new Set([state.me, ...state.drivers])].filter(Boolean).map((n) => h("option", { value: n })));
  $("#dd-quick").replaceChildren(...[...new Set([state.me, ...state.drivers])].filter(Boolean).map((n) =>
    h("button", { type: "button", class: "chip", "aria-pressed": String(n === cur), onclick: () => { $("#dd-name").value = n; for (const b of $("#dd-quick").children) b.setAttribute("aria-pressed", String(b.textContent === n || b.textContent === `Ich (${n})`)); } }, n === state.me ? `Ich (${n})` : n)));
  $("#dd-laps").replaceChildren(...laps.map((l) => h("label", { class: "dd-lap" },
    h("input", { type: "checkbox", value: l.id, checked: true }),
    h("span", { class: "num" }, `R${l.lap_number ?? "?"}`), h("span", { class: "num" }, fmt(l.lap_time_ms)),
    h("span", { class: "muted" }, l.driver || "–"))));
  // Name aus dem Spiel (z. B. Nickname): auf Wunsch immer diesem Fahrer zuordnen
  $("#dd-remember").checked = false;
  $("#dd-remember-row").hidden = !cur;
  $("#dd-remember-txt").textContent = `„${cur}“ künftig immer so zuordnen, auch alle bisherigen Runden`;
  $("#dd-form").dataset.cur = cur;
  $("#dd-error").textContent = "";
  dlg.showModal();
  $("#dd-name").focus();
}
$("#dd-cancel").addEventListener("click", () => $("#driver-dialog").close());
$("#dd-all").addEventListener("change", (e) => { for (const c of $("#dd-laps").querySelectorAll("input")) c.checked = e.target.checked; });
$("#dd-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#dd-name").value.trim();
  const ids = [...$("#dd-laps").querySelectorAll("input:checked")].map((c) => Number(c.value));
  if (!name) { $("#dd-error").textContent = "Bitte einen Namen eingeben."; return; }
  if (!ids.length) { $("#dd-error").textContent = "Keine Runde ausgewählt."; return; }
  try {
    const cur = $("#dd-form").dataset.cur;
    if ($("#dd-remember").checked && cur && cur !== name) {
      const ra = await fetch("/api/drivers/alias", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ alias: cur, driver: name }) });
      if (!ra.ok) throw new Error((await ra.json().catch(() => ({}))).detail || ra.status);
    }
    const r = await fetch("/api/laps/driver", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ driver: name, ids }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
    $("#driver-dialog").close();
    load();
  } catch (err) { $("#dd-error").textContent = `Speichern fehlgeschlagen: ${err.message}`; }
});
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.detail && currentTab() === "analyse") { drawChart(state.detail.laps, state.detail.pb); if (analysis.traced.length) renderAnalysis(); renderCoach(); renderProgress(); }
  }, 150);
});

load();
setInterval(() => { if (!document.hidden && $("#tooltip").hidden && currentTab() !== "live") load(); }, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && currentTab() !== "live") load(); });

// ---------------------------------------------------------------------------
// Analyse: wo Zeit gewonnen/verloren wird (braucht Runden mit Verlauf, Collector ≥ 0.2)
// ---------------------------------------------------------------------------
const SECTORS = 10;
const analysis = { c: null, traced: [], charts: [] };

function lapLabel(l, pbId) {
  const flags = [l.id === pbId ? "★ PB" : "", l.valid === false ? "✕" : "", l.estimated ? "≈" : ""].filter(Boolean).join(" ");
  return `R${l.lap_number ?? "?"} · ${fmt(l.lap_time_ms)} · ${fmtDate(l.recorded_at)}${flags ? " · " + flags : ""}`;
}

/** Zeit je Mini-Sektor (ms) aus dem Verlauf; null, wenn der Abschnitt nicht abgedeckt ist. */
function sectorTimes(l) {
  const t = l.trace.t, per = Math.round(t.length / SECTORS);
  const out = [];
  for (let k = 0; k < SECTORS; k++) {
    const start = k === 0 ? (t[0] != null ? 0 : null) : t[k * per];
    const end = k === SECTORS - 1 ? l.lap_time_ms : t[(k + 1) * per];
    out.push(start != null && end != null && end > start ? end - start : null);
  }
  return out;
}

function idealLap(traced) {
  const best = Array(SECTORS).fill(null);
  for (const l of traced.filter(isCounting)) {
    sectorTimes(l).forEach((v, k) => { if (v != null && (best[k] == null || v < best[k])) best[k] = v; });
  }
  return best.every((v) => v != null) ? best.reduce((a, b) => a + b, 0) : null;
}

async function loadAnalysis(c) {
  analysis.c = c;
  const traced = await getJSON(`/api/traces?${new URLSearchParams({ game: c.game, track: c.track, layout: c.layout, car: c.car, ...driverParam() })}`);
  analysis.traced = traced;
  analysis.geo = null;
  if (!traced.some((l) => l.trace.x && l.trace.x.filter((v) => v != null).length > 100)) {
    try {
      const pts = traced.length ? Math.max(50, Math.min(1000, traced[0].trace.t.length)) : 200;
      const tm = await getJSON(`/api/trackmap?${new URLSearchParams({ game: c.game, track: c.track, layout: c.layout, points: pts })}`);
      if (tm.x) analysis.geo = { id: "trackmap", trace: tm };
    } catch { /* ohne Karte */ }
  }
  const pbId = c.best_valid && c.best_valid.id;
  const pickers = document.querySelector("#analysis .pickers");
  if (!traced.length) {
    pickers.hidden = true;
    $("#analysis-sub").textContent = "";
    $("#analysis-body").replaceChildren(h("p", { class: "analysis-empty" },
      "Für dieses Auto auf dieser Strecke gibt es noch keine Runden mit Verlauf. Ab Collector 0.2 zeichnet SimDash bei jeder Runde Zeit, Tempo und Pedale entlang der Strecke auf – fahr ein paar Runden, dann erscheint hier die Analyse."));
    return;
  }
  pickers.hidden = false;
  const counting = traced.filter(isCounting);
  const byTime = [...counting].sort((a, b) => a.lap_time_ms - b.lap_time_ms);
  const sel = counting[0] || traced[0];                       // neueste gültige Runde
  const ref = byTime.find((l) => l.id !== sel.id) || byTime[0] || sel;   // schnellste andere
  for (const [el, cur] of [[$("#pick-lap"), sel], [$("#pick-ref"), ref]]) {
    el.replaceChildren(...traced.map((l) => h("option", { value: l.id }, lapLabel(l, pbId))));
    el.value = String(cur.id);
  }
  renderAnalysis();
}

/** Gänge einer Runde; kurzes N beim Schalten und Lücken zeigen den letzten echten Gang. */
function gearOf(l) {
  const g = l.trace.g;
  if (!g) return null;
  let last = null;
  return g.map((v) => { if (v != null && v > 0) last = v; return last; });
}

function renderAnalysis() {
  const traced = analysis.traced;
  const sel = traced.find((l) => String(l.id) === $("#pick-lap").value);
  const ref = traced.find((l) => String(l.id) === $("#pick-ref").value);
  const body = $("#analysis-body");
  analysis.charts = [];
  if (!sel || !ref) return;
  const pbId = analysis.c.best_valid && analysis.c.best_valid.id;
  const refDat = ref.id === pbId ? "deiner Bestzeit" : `Runde ${ref.lap_number}`;   // "im Vergleich zu …"
  const refAkk = ref.id === pbId ? "deine Bestzeit" : `Runde ${ref.lap_number}`;    // "gegen …"
  $("#analysis-sub").textContent = sel.id === ref.id
    ? "Wähle eine zweite Runde zum Vergleich."
    : `Runde ${sel.lap_number} (${fmt(sel.lap_time_ms)}) im Vergleich zu ${refDat} (${fmt(ref.lap_time_ms)})`;

  const sT = sectorTimes(sel), rT = sectorTimes(ref);
  const sd = sT.map((v, k) => (v != null && rT[k] != null ? v - rT[k] : null));
  const known = sd.map((v, k) => [v, k]).filter(([v]) => v != null);
  const worst = known.reduce((a, b) => (b[0] > a[0] ? b : a), [0, -1]);
  const bestG = known.reduce((a, b) => (b[0] < a[0] ? b : a), [0, -1]);
  const ideal = idealLap(traced);
  const pbTime = analysis.c.best_valid && analysis.c.best_valid.lap_time_ms;
  const range = (k) => `${k * 10}–${(k + 1) * 10} % der Runde`;
  const ins = (label, value, sub, mark) => h("div", { class: "insight" },
    h("div", { class: "label" }, mark ? h("span", { class: mark }) : null, label), h("div", { class: "value" }, value), h("div", { class: "sub" }, sub));

  const tiles = h("div", { class: "insights" },
    ins("Abstand gesamt", sel.id === ref.id ? "–" : `${fmtDelta(sel.lap_time_ms - ref.lap_time_ms)} s`, `gegen ${refAkk}`),
    ins("Größter Verlust", worst[1] >= 0 && worst[0] > 0 ? `+${(worst[0] / 1000).toFixed(3)} s` : "–", worst[1] >= 0 && worst[0] > 0 ? `Abschnitt ${worst[1] + 1} · ${range(worst[1])}` : "nirgends langsamer", "mark-loss"),
    ins("Größter Gewinn", bestG[1] >= 0 && bestG[0] < 0 ? `−${(-bestG[0] / 1000).toFixed(3)} s` : "–", bestG[1] >= 0 && bestG[0] < 0 ? `Abschnitt ${bestG[1] + 1} · ${range(bestG[1])}` : "nirgends schneller", "mark-gain"),
    ins("Ideale Runde", ideal ? fmt(ideal) : "–", ideal && pbTime ? `Potenzial ${fmtDelta(ideal - pbTime)} s zur PB` : "beste Abschnitte aller Runden"),
  );

  const kids = [tiles];

  // 0) Streckenkarte (nur Runden mit Positionsdaten, Collector ab 0.3)
  const geo = [sel, ref, ...traced].find((l) => l.trace.x && l.trace.z && l.trace.x.filter((v) => v != null).length > 100) || analysis.geo;
  const hasV = !!(sel.trace.v && ref.trace.v);
  let mapMode = analysis.mapMode || "vdiff", mapBox = null;
  if (mapMode === "vdiff" && (!hasV || sel.id === ref.id)) mapMode = sel.id === ref.id && sel.trace.v ? "speed" : "delta";
  if (mapMode === "delta" && sel.id === ref.id) mapMode = "speed";
  if (mapMode === "speed" && !sel.trace.v) mapMode = "delta";
  if (geo) {
    mapBox = h("div", { class: "trackmap", role: "img", "aria-label": { vdiff: "Streckenkarte: wo du langsamer oder schneller warst (km/h)", delta: "Streckenkarte: wo Zeit verloren oder gewonnen wurde", speed: "Streckenkarte: Tempo entlang der Runde" }[mapMode] });
    const modeBtn = (mode, label, disabled) => {
      const b = h("button", { class: "chip", type: "button", "aria-pressed": String(mapMode === mode) }, label);
      if (disabled) b.disabled = true;
      b.addEventListener("click", () => { analysis.mapMode = mode; renderAnalysis(); });
      return b;
    };
    kids.push(h("div", { class: "map-head" },
      h("div", { class: "subchart-title" }, "Streckenkarte"),
      h("div", { class: "chips map-modes" },
        modeBtn("vdiff", "Tempo-Differenz", !hasV || sel.id === ref.id),
        modeBtn("delta", "Zeitverlust", sel.id === ref.id),
        modeBtn("speed", "Tempo", !sel.trace.v))),
      h("div", { class: "legend", id: "map-legend" }), mapBox);
  } else {
    kids.push(h("div", { class: "subchart-title" }, "Streckenkarte"),
      h("p", { class: "analysis-empty" }, "Für diese Strecke gibt es noch keine Streckenform. Fahr eine Runde mit dem neuen Collector (ab 0.4, egal welches Auto) – danach haben auch alle alten Runden hier eine Karte. Geht mit AC EVO, ACC und Assetto Corsa, nicht mit iRacing."));
  }

  // 1) Delta über die Runde
  const n = sel.trace.t.length;
  const delta = sel.trace.t.map((v, i) => (v != null && ref.trace.t[i] != null ? v - ref.trace.t[i] : null));
  delta.push(sel.lap_time_ms - ref.lap_time_ms);                 // Ziellinie
  const xs = delta.map((_, i) => i / n);
  const deltaBox = h("div", { class: "xy", role: "img", "aria-label": "Zeitabstand entlang der Runde" });
  kids.push(h("div", { class: "subchart-title" }, "Zeitabstand entlang der Runde"),
    h("div", { class: "legend" },
      h("span", { class: "key" }, h("span", { class: "mark-loss" }), "langsamer (über 0)"),
      h("span", { class: "key" }, h("span", { class: "mark-gain" }), "schneller (unter 0)")),
    deltaBox);

  // 2) Mini-Sektoren
  const secBox = h("div", { class: "xy sectors", role: "img", "aria-label": "Zeitgewinn und -verlust je Abschnitt" });
  kids.push(h("div", { class: "subchart-title" }, `${SECTORS} Abschnitte`), secBox);

  // 3) Tempo
  let speedBox = null;
  if (sel.trace.v && ref.trace.v) {
    speedBox = h("div", { class: "xy", role: "img", "aria-label": "Tempo entlang der Runde" });
    const key = (color, label) => { const v = s("svg", { width: 18, height: 10 }); v.append(s("line", { x1: 1, y1: 5, x2: 17, y2: 5, stroke: color, "stroke-width": 2, "stroke-linecap": "round" })); return h("span", { class: "key" }, v, label); };
    kids.push(h("div", { class: "subchart-title" }, "Tempo (km/h)"),
      h("div", { class: "legend" }, key("var(--series-1)", `Runde ${sel.lap_number}`), key("var(--series-2)", ref.id === pbId ? "Bestzeit" : `Runde ${ref.lap_number}`)),
      speedBox);
  }

  // 4) Gang und Lenkung (Collector ab 0.6, alte Runden haben das nicht)
  const lineKey = (color, label) => { const v = s("svg", { width: 18, height: 10 }); v.append(s("line", { x1: 1, y1: 5, x2: 17, y2: 5, stroke: color, "stroke-width": 2, "stroke-linecap": "round" })); return h("span", { class: "key" }, v, label); };
  const lapKeys = (field, extra) => h("div", { class: "legend" },
    sel.trace[field] ? lineKey("var(--series-1)", `Runde ${sel.lap_number}`) : null,
    ref.trace[field] ? lineKey("var(--series-2)", ref.id === pbId ? "Bestzeit" : `Runde ${ref.lap_number}`) : null,
    !sel.trace[field] || !ref.trace[field] ? h("span", { class: "key muted" }, "die andere Runde hat diese Daten noch nicht") : null,
    extra ? h("span", { class: "key muted" }, extra) : null);
  const hasGear = sel.trace.g || ref.trace.g, hasSteer = sel.trace.st || ref.trace.st;
  const gearBox = hasGear ? h("div", { class: "xy small", role: "img", "aria-label": "Gang entlang der Runde" }) : null;
  const steerBox = hasSteer ? h("div", { class: "xy small", role: "img", "aria-label": "Lenkung entlang der Runde" }) : null;
  if (gearBox) kids.push(h("div", { class: "subchart-title" }, "Gang"), lapKeys("g"), gearBox);
  if (steerBox) kids.push(h("div", { class: "subchart-title" }, "Lenkung (%)"), lapKeys("st", "oben = rechts"), steerBox);
  body.replaceChildren(...kids);

  const tipFor = (i) => {
    const pct = Math.round(xs[i] * 1000) / 10;
    const rows = [h("div", { class: "v" }, delta[i] == null ? "–" : `${fmtDelta(delta[i])} s`), h("div", { class: "k" }, `bei ${pct} % der Runde`)];
    if (speedBox && i < n) {
      const a = sel.trace.v[i], b = ref.trace.v[i];
      if (a != null) rows.push(h("div", { class: "k" }, h("i"), `${Math.round(a)} km/h Runde ${sel.lap_number}`));
      if (b != null) rows.push(h("div", { class: "k" }, h("i", { style: "background: var(--series-2)" }), `${Math.round(b)} km/h Vergleich`));
    }
    if (i < n) {
      const fmtPair = (arr1, arr2, f) => [arr1 && arr1[i] != null ? f(arr1[i]) : "–", arr2 && arr2[i] != null ? f(arr2[i]) : "–"].join(" / ");
      if (hasGear) rows.push(h("div", { class: "k" }, `Gang ${fmtPair(gearOf(sel), gearOf(ref), (v) => v)}`));
      if (hasSteer) rows.push(h("div", { class: "k" }, `Lenkung ${fmtPair(sel.trace.st, ref.trace.st, (v) => `${Math.round(v * 100)} %`)}`));
    }
    return rows;
  };

  if (mapBox) analysis.charts.push(drawTrackMap(mapBox, { geo, sel, ref, mode: mapMode, tip: tipFor }));
  analysis.charts.push(drawXY(deltaBox, { xs, series: [{ values: delta.map((v) => (v == null ? null : v / 1000)), color: "var(--text-primary)" }], signArea: true, zero: true, yFmt: (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(Math.abs(v) < 1 ? 2 : 1)}`, tip: tipFor }));
  drawSectors(secBox, sd, sT, rT);
  if (speedBox) {
    const sv = [...sel.trace.v, null], rv = [...ref.trace.v, null];
    analysis.charts.push(drawXY(speedBox, { xs, series: [{ values: rv, color: "var(--series-2)" }, { values: sv, color: "var(--series-1)" }], yFmt: (v) => Math.round(v), tip: tipFor }));
  }
  if (gearBox) {
    const series = [[ref, "var(--series-2)"], [sel, "var(--series-1)"]].filter(([l]) => l.trace.g).map(([l, color]) => ({ values: [...gearOf(l), null], color }));
    analysis.charts.push(drawXY(gearBox, { xs, series, yStep: 1, yFmt: (v) => Math.round(v), tip: tipFor }));
  }
  if (steerBox) {
    const series = [[ref, "var(--series-2)"], [sel, "var(--series-1)"]].filter(([l]) => l.trace.st).map(([l, color]) => ({ values: [...l.trace.st.map((v) => (v == null ? null : v * 100)), null], color }));
    analysis.charts.push(drawXY(steerBox, { xs, series, zero: true, yFmt: (v) => Math.round(v), tip: tipFor }));
  }
}

/* --- Streckenkarte ----------------------------------------------------------- */
const MAP_NEUTRAL = [0x48, 0x48, 0x44];                 // grauer Mittelpunkt (gleich schnell)
const MAP_GAIN = [0x39, 0x87, 0xe5], MAP_LOSS = [0xe6, 0x67, 0x67];
const SPEED_RAMP = ["#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6", "#cde2fb"]; // langsam → schnell
const hexRgb = (hx) => [1, 3, 5].map((k) => parseInt(hx.slice(k, k + 2), 16));
const mixRgb = (a, b, f) => `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
function rampColor(f) {
  const p = Math.max(0, Math.min(1, f)) * (SPEED_RAMP.length - 1), k = Math.min(SPEED_RAMP.length - 2, Math.floor(p));
  return mixRgb(hexRgb(SPEED_RAMP[k]), hexRgb(SPEED_RAMP[k + 1]), p - k);
}

/** Draufsicht der Strecke aus x/z; Segmente nach Zeitverlust (rot/blau) oder Tempo (blau hell = schnell). */
function drawTrackMap(box, { geo, sel, ref, mode, tip }) {
  const X = geo.trace.x, Z = geo.trace.z, n = X.length;
  const q = Math.max(1, Math.round(sel.trace.t.length / 200));      // Glättung an Punktdichte anpassen
  const idx = [...Array(n).keys()].filter((i) => X[i] != null && Z[i] != null);
  const W = box.clientWidth || 600, H = box.clientHeight || 320, pad = 26;
  const xs = idx.map((i) => X[i]), zs = idx.map((i) => Z[i]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const k = Math.min((W - 2 * pad) / Math.max(1, x1 - x0), (H - 2 * pad) / Math.max(1, z1 - z0));
  const ox = (W - (x1 - x0) * k) / 2, oz = (H - (z1 - z0) * k) / 2;
  const P = (i) => (X[i] == null || Z[i] == null ? null : [ox + (X[i] - x0) * k, oz + (Z[i] - z0) * k]);

  // Farbe je Segment i → i+1
  const color = new Array(n).fill(null);
  const legend = $("#map-legend");
  let vd = null;                                       // Tempo-Differenz (km/h), geglättet
  if (sel.trace.v && ref.trace.v) {
    const raw = sel.trace.v.map((a, i) => (a != null && ref.trace.v[i] != null ? a - ref.trace.v[i] : null));
    vd = raw.map((v, i) => {
      if (v == null) return null;
      const w = [];
      for (let o = -2 * q; o <= 2 * q; o++) if (raw[i + o] != null) w.push(raw[i + o]);
      return w.reduce((a, b) => a + b, 0) / w.length;
    });
  }
  const label = (i) => {
    if (mode === "vdiff") return vd && vd[i] != null ? `${vd[i] > 0.5 ? "+" : vd[i] < -0.5 ? "−" : "±"}${Math.abs(Math.round(vd[i]))} km/h` : null;
    if (mode === "speed") return sel.trace.v && sel.trace.v[i] != null ? `${Math.round(sel.trace.v[i])} km/h` : null;
    const a = sel.trace.t[i], b = ref.trace.t[i];
    return a != null && b != null ? `${fmtDelta(a - b)} s` : null;
  };
  if (mode === "vdiff") {
    const mags = vd.filter((v) => v != null).map(Math.abs).sort((a, b) => a - b);
    const scale = Math.max(6, Math.min(25, mags[Math.floor(mags.length * 0.95)] || 0));
    vd.forEach((v, i) => { if (v != null && vd[i + 1] != null) { const m = (v + vd[i + 1]) / 2; color[i] = mixRgb(MAP_NEUTRAL, m < 0 ? MAP_LOSS : MAP_GAIN, Math.sqrt(Math.min(1, Math.abs(m) / scale))); } });
    legend.replaceChildren(
      h("span", { class: "key" }, h("span", { class: "mark-loss" }), "langsamer"),
      h("span", { class: "key" }, h("span", { class: "mark-gain" }), "schneller"),
      h("span", { class: "key" }, h("span", { class: "mark-neutral" }), "gleich"),
      h("span", { class: "key muted" }, `volle Farbe ab ±${Math.round(scale)} km/h · Runde ${sel.lap_number} gegen Vergleich`));
  } else if (mode === "delta") {
    const d = sel.trace.t.map((v, i) => (v != null && ref.trace.t[i] != null ? v - ref.trace.t[i] : null));
    // Verlust je Strecke = Steigung des Abstands über ±4 Punkte (glättet das Messrauschen)
    const W2 = 4 * q;
    const rate = d.map((_, i) => {
      const a = d[Math.max(0, i - W2)], b = d[Math.min(n - 1, i + 1 + W2)];
      const span = Math.min(n - 1, i + 1 + W2) - Math.max(0, i - W2);
      return d[i] == null || d[i + 1] == null || a == null || b == null ? null : (b - a) / span;
    });
    const mags = rate.filter((v) => v != null).map(Math.abs).sort((a, b) => a - b);
    const scale = Math.max(4, mags[Math.floor(mags.length * 0.9)] || 0);
    rate.forEach((r, i) => { if (r != null) color[i] = mixRgb(MAP_NEUTRAL, r > 0 ? MAP_LOSS : MAP_GAIN, Math.min(1, Math.abs(r) / scale)); });
    legend.replaceChildren(
      h("span", { class: "key" }, h("span", { class: "mark-loss" }), "verliert Zeit"),
      h("span", { class: "key" }, h("span", { class: "mark-gain" }), "gewinnt Zeit"),
      h("span", { class: "key" }, h("span", { class: "mark-neutral" }), "gleich"),
      h("span", { class: "key muted" }, `Runde ${sel.lap_number} gegen Vergleich`));
  } else {
    const v = sel.trace.v, known = v.filter((a) => a != null);
    const lo = Math.min(...known), hi = Math.max(...known);
    v.forEach((a, i) => { if (a != null && v[i + 1] != null) color[i] = rampColor((((a + v[i + 1]) / 2) - lo) / Math.max(1, hi - lo)); });
    legend.replaceChildren(h("span", { class: "key" }, `${Math.round(lo)} km/h`, h("span", { class: "ramp", style: `background: linear-gradient(90deg, ${SPEED_RAMP.join(",")})` }), `${Math.round(hi)} km/h`),
      h("span", { class: "key muted" }, `Runde ${sel.lap_number}`));
  }

  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  // Asphalt-Unterlage, damit Lücken und neutrale Stellen sichtbar bleiben
  let under = "";
  for (let i = 0; i < n; i++) { const p = P(i); if (!p) continue; under += `${P(i - 1) && i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`; }
  svg.append(s("path", { class: "map-casing", d: under }), s("path", { class: "map-base", d: under }));
  const segs = s("g", { class: "map-segs" });
  for (let i = 0; i < n - 1; i++) {
    const a = P(i), b = P(i + 1);
    if (!a || !b || !color[i]) continue;
    segs.append(s("line", { x1: a[0].toFixed(1), y1: a[1].toFixed(1), x2: b[0].toFixed(1), y2: b[1].toFixed(1), stroke: color[i] }));
  }
  svg.append(segs);

  // Start/Ziel und Abschnittsnummern (wie im Balkendiagramm)
  const per = Math.round(n / SECTORS);
  const cx = W / 2, cy = H / 2;
  for (let kk = 0; kk < SECTORS; kk++) {
    const i = idx.find((j) => j >= kk * per);
    if (i == null) continue;
    const p = P(i), q = P(Math.min(n - 1, i + 2)) || p;
    let nx = -(q[1] - p[1]), ny = q[0] - p[0];
    const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
    if ((p[0] - cx) * nx + (p[1] - cy) * ny < 0) { nx = -nx; ny = -ny; }   // nach außen
    if (kk === 0 && i <= 2) {
      svg.append(s("line", { class: "map-start", x1: p[0] - nx * 9, y1: p[1] - ny * 9, x2: p[0] + nx * 9, y2: p[1] + ny * 9 }));
    }
    svg.append(s("circle", { class: "map-tick", cx: p[0], cy: p[1], r: 2.5 }));
    const t = s("text", { class: "map-label", x: p[0] + nx * 15, y: p[1] + ny * 15 + 4, "text-anchor": "middle" });
    t.textContent = String(kk + 1); svg.append(t);
  }

  // Nach außen zeigende Normale an Punkt i (für Beschriftungen)
  const outward = (i) => {
    const p = P(i), q = P(Math.min(n - 1, i + 2)) || P(Math.max(0, i - 2)) || p;
    let nx = -(q[1] - p[1]), ny = q[0] - p[0];
    const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
    if ((p[0] - cx) * nx + (p[1] - cy) * ny < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  };
  const callouts = s("g", { class: "map-callouts" });
  // Die drei Stellen mit dem größten Tempoverlust direkt beschriften (mind. 6 % der Runde auseinander)
  if (mode === "vdiff" && vd) {
    const cand = idx.filter((i) => vd[i] != null && vd[i] < -3).sort((a, b) => vd[a] - vd[b]);
    const picked = [];
    for (const i of cand) {
      if (picked.length >= 3) break;
      if (picked.every((j) => Math.min(Math.abs(i - j), n - Math.abs(i - j)) > n * 0.06)) picked.push(i);
    }
    for (const i of picked) callouts.append(mapBubble(P(i), outward(i), label(i), "static"));
  }
  const dot = s("circle", { class: "map-dot", r: 6, visibility: "hidden" });
  const hover = s("g", { class: "map-hover", visibility: "hidden" });
  const hit = s("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" });
  svg.append(callouts, dot, hover, hit);
  box.replaceChildren(svg);

  const chart = {
    showAt(i) {
      i = Math.min(i, n - 1);
      const p = P(i); if (!p) return this.hide();
      dot.setAttribute("cx", p[0]); dot.setAttribute("cy", p[1]); dot.setAttribute("visibility", "visible");
      const txt = label(i);
      hover.replaceChildren(...(txt ? [mapBubble(p, outward(i), txt, "hover")] : []));
      hover.setAttribute("visibility", txt ? "visible" : "hidden");
      callouts.setAttribute("opacity", "0.35");
    },
    hide() { dot.setAttribute("visibility", "hidden"); hover.setAttribute("visibility", "hidden"); callouts.removeAttribute("opacity"); },
  };
  const tipEl = $("#tooltip");
  const nearest = (e) => {
    const r = box.getBoundingClientRect(), mx = ((e.clientX - r.left) / r.width) * W, my = ((e.clientY - r.top) / r.height) * H;
    let best = null, bd = 28 * 28;
    for (const i of idx) { const p = P(i), dd = (p[0] - mx) ** 2 + (p[1] - my) ** 2; if (dd < bd) { bd = dd; best = i; } }
    return best;
  };
  const show = (e) => {
    const i = nearest(e);
    if (i == null) { analysis.charts.forEach((c) => c.hide()); tipEl.hidden = true; return; }
    analysis.charts.forEach((c) => c.showAt(i));
    tipEl.hidden = true;                                  // auf der Karte spricht die Blase
  };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { analysis.charts.forEach((c) => c.hide()); tipEl.hidden = true; } });
  return chart;
}

/** Sprechblase wie bei GPS-Karten: dunkle Pille mit Spitze, nach außen versetzt. */
function mapBubble(p, [nx, ny], text, kind) {
  const g = s("g", { class: `map-bubble ${kind}` });
  const w = Math.max(44, text.length * 7.4 + 18), hgt = 24, off = kind === "hover" ? 26 : 22;
  const bx = p[0] + nx * off, by = p[1] + ny * off;
  // Spitze vom Punkt zur Blase
  g.append(s("line", { class: "stem", x1: p[0] + nx * 5, y1: p[1] + ny * 5, x2: bx, y2: by }));
  if (kind === "static") g.append(s("circle", { class: "pin", cx: p[0], cy: p[1], r: 4 }));
  g.append(s("rect", { x: bx - w / 2, y: by - hgt / 2, width: w, height: hgt, rx: 12 }));
  const t = s("text", { x: bx, y: by + 4.5, "text-anchor": "middle" }); t.textContent = text;
  g.append(t);
  return g;
}

function niceStep(range, target = 4) {
  const raw = range / target, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((f) => f * p).find((st) => st >= raw) || 10 * p;
}

/** Linien über die Runde (x = 0..1). Crosshair ist mit den anderen Analyse-Diagrammen gekoppelt. */
function drawXY(box, { xs, series, signArea = false, zero = false, yFmt, yStep, tip }) {
  const W = box.clientWidth || 600, H = box.clientHeight || 200;
  const m = { l: 46, r: 10, t: 10, b: 22 };
  const all = series.flatMap((se) => se.values.filter((v) => v != null));
  if (zero) all.push(0);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const padY = (hi - lo) * 0.08; lo -= padY; hi += padY;
  const x = (f) => m.l + f * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  const grid = s("g", { class: "grid" }), axis = s("g", { class: "axis" });
  const st = yStep || niceStep(hi - lo);
  for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) {
    grid.append(s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    const t = s("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }); t.textContent = yFmt(v); axis.append(t);
  }
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const t = s("text", { x: x(f), y: H - 6, "text-anchor": f === 0 ? "start" : f === 1 ? "end" : "middle" });
    t.textContent = `${Math.round(f * 100)} %`; axis.append(t);
  }
  svg.append(grid, axis);

  const runs = (values) => {   // zusammenhängende Abschnitte ohne Lücken
    const out = []; let cur = [];
    values.forEach((v, i) => { if (v == null) { if (cur.length) out.push(cur); cur = []; } else cur.push([xs[i], v]); });
    if (cur.length) out.push(cur);
    return out;
  };

  if (signArea) {
    const id = `c${Math.random().toString(36).slice(2, 8)}`;
    const defs = s("defs");
    const up = s("clipPath", { id: `${id}u` }); up.append(s("rect", { x: 0, y: 0, width: W, height: y(0) }));
    const dn = s("clipPath", { id: `${id}d` }); dn.append(s("rect", { x: 0, y: y(0), width: W, height: H }));
    defs.append(up, dn); svg.append(defs);
    for (const run of runs(series[0].values)) {
      const d = `M${x(run[0][0])},${y(0)}` + run.map(([f, v]) => `L${x(f).toFixed(1)},${y(v).toFixed(1)}`).join("") + `L${x(run[run.length - 1][0])},${y(0)}Z`;
      svg.append(s("path", { d, fill: "var(--loss)", opacity: 0.28, "clip-path": `url(#${id}u)` }));
      svg.append(s("path", { d, fill: "var(--gain)", opacity: 0.28, "clip-path": `url(#${id}d)` }));
    }
  }
  if (zero) svg.append(s("line", { class: "zero", x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
  for (const se of series) {
    for (const run of runs(se.values)) {
      const d = run.map(([f, v], k) => `${k ? "L" : "M"}${x(f).toFixed(1)},${y(v).toFixed(1)}`).join("");
      svg.append(s("path", { d, fill: "none", stroke: se.color, "stroke-width": signArea ? 1.5 : 2, "stroke-linejoin": "round" }));
    }
  }

  const cross = s("line", { class: "crosshair", y1: m.t, y2: H - m.b, visibility: "hidden" });
  const hit = s("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent", tabindex: 0, "aria-label": "Mit Pfeiltasten entlang der Runde bewegen" });
  svg.append(cross, hit);
  box.replaceChildren(svg);

  const chart = {
    showAt(i) { cross.setAttribute("x1", x(xs[i])); cross.setAttribute("x2", x(xs[i])); cross.setAttribute("visibility", "visible"); },
    hide() { cross.setAttribute("visibility", "hidden"); },
  };
  let cur = 0;
  const tipEl = $("#tooltip");
  const showAll = (i, cx, cy) => {
    cur = i;
    analysis.charts.forEach((c) => c.showAt(i));
    tipEl.replaceChildren(...tip(i));
    tipEl.hidden = false;
    const r = box.getBoundingClientRect();
    const px = cx ?? r.left + (x(xs[i]) / W) * r.width, py = cy ?? r.top + r.height / 3;
    tipEl.style.left = `${Math.min(Math.max(8, px + 14), window.innerWidth - tipEl.offsetWidth - 8)}px`;
    tipEl.style.top = `${Math.max(8, py - tipEl.offsetHeight - 14)}px`;
  };
  const hideAll = () => { analysis.charts.forEach((c) => c.hide()); tipEl.hidden = true; };
  const idxAt = (clientX) => {
    const r = box.getBoundingClientRect();
    const f = (((clientX - r.left) / r.width) * W - m.l) / (W - m.l - m.r);
    return Math.max(0, Math.min(xs.length - 1, Math.round(f * (xs.length - 1))));
  };
  hit.addEventListener("pointermove", (e) => showAll(idxAt(e.clientX), e.clientX, e.clientY));
  hit.addEventListener("pointerdown", (e) => showAll(idxAt(e.clientX), e.clientX, e.clientY));
  hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hideAll(); });
  hit.addEventListener("focus", () => showAll(cur));
  hit.addEventListener("blur", hideAll);
  hit.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { showAll(Math.min(xs.length - 1, cur + 2)); e.preventDefault(); }
    if (e.key === "ArrowLeft") { showAll(Math.max(0, cur - 2)); e.preventDefault(); }
    if (e.key === "Escape") hideAll();
  });
  return chart;
}

/** Balken je Abschnitt: über 0 = Verlust (rot), unter 0 = Gewinn (blau). Beschriftet nur Extremwerte. */
function drawSectors(box, deltas, sT, rT) {
  const W = box.clientWidth || 600, H = box.clientHeight || 170;
  const m = { l: 46, r: 10, t: 16, b: 22 };
  const vals = deltas.map((v) => (v == null ? null : v / 1000));
  const known = vals.filter((v) => v != null);
  const ext = Math.max(0.05, ...known.map(Math.abs)) * 1.15;
  const y = (v) => m.t + (1 - (v + ext) / (2 * ext)) * (H - m.t - m.b);
  const bw = (W - m.l - m.r) / vals.length;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  const axis = s("g", { class: "axis" });
  const st = niceStep(ext, 2);
  for (let v = -Math.floor(ext / st) * st; v <= ext; v += st) {
    const t = s("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`; axis.append(t);
  }
  svg.append(axis, s("line", { class: "zero", x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
  const maxI = known.length ? vals.indexOf(Math.max(...known)) : -1;
  const minI = known.length ? vals.indexOf(Math.min(...known)) : -1;
  const tipEl = $("#tooltip");
  vals.forEach((v, k) => {
    const x0 = m.l + k * bw + 1, w = bw - 2;                 // 2 px Abstand zwischen Balken
    const lbl = s("text", { x: x0 + w / 2, y: H - 6, "text-anchor": "middle" });
    lbl.textContent = String(k + 1); axis.append(lbl);
    if (v == null) return;
    const y0 = y(0), y1 = y(v), top = Math.min(y0, y1), hgt = Math.max(1, Math.abs(y1 - y0));
    const r = Math.min(4, hgt, w / 2);
    // Rundung nur am Datenende, an der Nulllinie gerade
    const d = v >= 0
      ? `M${x0},${y0}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + w - r}Q${x0 + w},${top} ${x0 + w},${top + r}V${y0}Z`
      : `M${x0},${y0}V${top + hgt - r}Q${x0},${top + hgt} ${x0 + r},${top + hgt}H${x0 + w - r}Q${x0 + w},${top + hgt} ${x0 + w},${top + hgt - r}V${y0}Z`;
    const bar = s("path", { d, fill: v >= 0 ? "var(--loss)" : "var(--gain)", tabindex: 0 });
    const show = (cx, cy) => {
      tipEl.replaceChildren(
        h("div", { class: "v" }, `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)} s`),
        h("div", { class: "k" }, `Abschnitt ${k + 1} · ${k * 10}–${(k + 1) * 10} % der Runde`),
        h("div", { class: "k" }, `${(sT[k] / 1000).toFixed(3)} s gegen ${(rT[k] / 1000).toFixed(3)} s`));
      tipEl.hidden = false;
      const rr = box.getBoundingClientRect();
      const px = cx ?? rr.left + ((x0 + w / 2) / W) * rr.width, py = cy ?? rr.top + (top / H) * rr.height;
      tipEl.style.left = `${Math.min(Math.max(8, px + 14), window.innerWidth - tipEl.offsetWidth - 8)}px`;
      tipEl.style.top = `${Math.max(8, py - tipEl.offsetHeight - 14)}px`;
      bar.setAttribute("opacity", "0.8");
    };
    const hide = () => { tipEl.hidden = true; bar.removeAttribute("opacity"); };
    // Trefferfläche größer als der Balken: ganze Spalte
    const hit = s("rect", { x: x0 - 1, y: m.t, width: w + 2, height: H - m.t - m.b, fill: "transparent" });
    for (const el of [bar, hit]) {
      el.addEventListener("pointermove", (e) => show(e.clientX, e.clientY));
      el.addEventListener("pointerdown", (e) => show(e.clientX, e.clientY));
      el.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
    }
    bar.addEventListener("focus", () => show()); bar.addEventListener("blur", hide);
    svg.append(hit, bar);
    if (k === maxI && v > 0 || k === minI && v < 0) {
      const t = s("text", { class: "sector-label", x: x0 + w / 2, y: v >= 0 ? top - 4 : top + hgt + 12, "text-anchor": "middle" });
      t.textContent = `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`; svg.append(t);
    }
  });
  box.replaceChildren(svg);
}

$("#pick-lap").addEventListener("change", renderAnalysis);
$("#pick-ref").addEventListener("change", renderAnalysis);
