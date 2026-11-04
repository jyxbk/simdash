// SimDash – Coach: wo in deiner Bestzeit noch Zeit steckt, Kurve für Kurve (Daten: /api/coach).
// Läuft im selben globalen Bereich wie app.js (h, s, $, fmt, analysis, drawTrackMap-Farben …).
"use strict";

const coachState = { c: null, data: null, focus: null };
const MIN_GAIN = 30;                       // ab so vielen ms lohnt sich ein Tipp

const secs = (ms, digits = 3) => `${(ms / 1000).toFixed(digits)} s`;

async function loadCoach(c) {
  coachState.c = c;
  const q = new URLSearchParams({ game: c.game, track: c.track, layout: c.layout, car: c.car, ...driverParam() });
  let data = null;
  try { data = await getJSON(`/api/coach?${q}`); } catch { /* ohne Coach */ }
  if (coachState.c !== c) return;           // inzwischen andere Kombination gewählt
  coachState.data = data;
  renderCoach();
}

/** Bestzeit-Runde gegen die beste Fahrt in einer Kurve im Rundenvergleich öffnen. */
function compareCorner(corner) {
  const d = coachState.data;
  if (!d || !d.ref) return;
  const lap = $("#pick-lap"), ref = $("#pick-ref");
  if (![...lap.options].some((o) => o.value === String(d.ref.id))) return;
  lap.value = String(d.ref.id);
  ref.value = String(corner.best_lap.id);
  analysis.mapMode = "vdiff";
  renderAnalysis();
  $("#analysis").scrollIntoView({ behavior: "smooth", block: "start" });
  const n = analysis.traced.length ? analysis.traced[0].trace.t.length : 200;
  setTimeout(() => analysis.charts.forEach((ch) => ch.showAt(Math.round(corner.apex * n))), 450);
}

function renderCoach() {
  const d = coachState.data, body = $("#coach-body"), sub = $("#coach-sub");
  if (!body) return;
  if (!d) { sub.textContent = ""; body.replaceChildren(h("p", { class: "analysis-empty" }, "Coach gerade nicht erreichbar.")); return; }
  if (!d.laps_used || d.laps_used < 2 || !d.corners.length) {
    sub.textContent = "";
    body.replaceChildren(h("p", { class: "analysis-empty" },
      d.laps_counting < 2
        ? "Für den Coach brauchst du mindestens zwei gültige Runden mit diesem Auto auf dieser Strecke. Dann vergleicht er jede Kurve deiner Bestzeit mit deiner besten Fahrt dort."
        : "Für den Coach fehlen Runden mit Verlauf (Tempo, Pedale), denn die zeichnet erst der Collector ab 0.2 auf. Fahr ein paar Runden, dann zeigt er dir hier Kurve für Kurve, wo Zeit liegt."));
    return;
  }
  const pbLabel = `Runde ${d.ref.lap_number ?? "?"}`;
  sub.textContent = `Deine Bestzeit (${pbLabel}) gegen deine beste Fahrt in jeder Kurve · ${d.laps_used} saubere Runden${d.track_length_m ? ` · Strecke ≈ ${(d.track_length_m / 1000).toFixed(2).replace(".", ",")} km` : ""}`;

  const corners = d.corners;
  const ranked = corners.filter((c) => c.gain_ms >= MIN_GAIN).sort((a, b) => b.gain_ms - a.gain_ms);
  const top = ranked.slice(0, 3);
  const cons = d.consistency || {};
  const ins = (label, value, subTxt, mark) => h("div", { class: "insight" },
    h("div", { class: "label" }, mark ? h("span", { class: mark }) : null, label), h("div", { class: "value" }, value), h("div", { class: "sub" }, subTxt));

  const tiles = h("div", { class: "insights" },
    ins("Bestzeit", fmt(d.ref.lap_time_ms), `${pbLabel} · ${fmtDate(d.ref.recorded_at)}`),
    ins("Ideale Runde", d.ideal_ms ? fmt(d.ideal_ms) : "–", "deine beste Fahrt in jeder Kurve"),
    ins("Potenzial", d.potential_ms != null ? `−${secs(d.potential_ms)}` : "–",
      d.potential_ms != null ? (ranked.length ? `davon ${secs(top.reduce((a, c) => a + c.gain_ms, 0), 2)} in ${top.length === 1 ? "einer Kurve" : `${top.length} Kurven`}` : "nichts Nennenswertes") : "", "mark-loss"),
    ins("Konstanz", cons.median_ms ? `+${secs(cons.median_ms - d.pb_ms, 2)}` : "–",
      cons.laps ? `Median über PB · ${cons.within_05} von ${d.laps_counting} Runden ≤ 0,5 s dran` : ""),
  );

  // Die größten Baustellen als Karten
  const cards = top.length
    ? h("div", { class: "coach-cards" }, top.map((c, k) => coachCard(c, k)))
    : h("p", { class: "analysis-empty" }, "Deine Bestzeit ist schon in jeder Kurve deine beste Fahrt. Mehr Zeit findest du nur noch mit Neuem: später bremsen, mehr Tempo mitnehmen, andere Linie.");

  const notes = [];
  const shaky = corners.find((c) => c.no === d.least_consistent);
  if (shaky && shaky.spread_ms >= 80) {
    notes.push(h("li", {}, h("b", {}, `Kurve ${shaky.no}`), ` fährst du am unterschiedlichsten (±${secs(shaky.spread_ms, 2)} von Runde zu Runde). Such dir dort einen festen Bremspunkt, z. B. ein Schild oder einen Randstein.`));
  }
  if (cons.stdev_ms && cons.laps >= 4 && cons.stdev_ms > 700) {
    notes.push(h("li", {}, `Deine Runden streuen um ±${secs(cons.stdev_ms, 1)}. Erst gleichmäßig werden, dann schneller. Das bringt hier mehr als eine einzelne schnelle Runde.`));
  }

  // Karte + Tabelle aller Kurven
  const geo = coachGeo(d);
  const mapBox = geo ? h("div", { class: "trackmap coach-map", role: "img", "aria-label": "Streckenkarte mit nummerierten Kurven, rot = dort steckt Zeit" }) : null;
  const table = coachTable(corners, top);
  const grid = h("div", { class: "coach-grid" },
    mapBox ? h("div", { class: "coach-mapwrap" },
      h("div", { class: "legend" },
        h("span", { class: "key" }, h("span", { class: "mark-loss" }), "hier steckt Zeit"),
        h("span", { class: "key" }, h("span", { class: "mark-neutral" }), "schon optimal"),
        h("span", { class: "key muted" }, "Nummer antippen")), mapBox) : null,
    table);

  body.replaceChildren(tiles, cards, notes.length ? h("ul", { class: "coach-notes" }, notes) : "",
    h("div", { class: "subchart-title" }, "Alle Kurven"), grid, h("div", { id: "corner-history", class: "corner-history" }));
  if (mapBox) drawCoachMap(mapBox, geo, corners, top);
  renderCornerHistory();
}

function coachCard(c, rank) {
  const ph = c.phase;
  const entry = ph ? Math.max(0, ph.entry_ms) : 0, exit = ph ? Math.max(0, ph.exit_ms) : 0;
  const sum = entry + exit || 1;
  const phaseBar = ph && (entry || exit) ? h("div", { class: "phase" },
    h("div", { class: "phase-bar", "aria-hidden": "true" },
      h("span", { class: "in", style: `width:${(entry / sum) * 100}%` }), h("span", { class: "out", style: `width:${(exit / sum) * 100}%` })),
    h("div", { class: "phase-keys" },
      h("span", {}, h("i", { class: "in" }), `Anbremsen & Einlenken ${secs(entry, 2)}`),
      h("span", {}, h("i", { class: "out" }), `Ausgang ${secs(exit, 2)}`))) : null;
  const rm = c.ref_metrics, bm = c.best_metrics;
  const facts = [
    `Scheitel ${Math.round(rm.v_min)} → ${Math.round(bm.v_min)} km/h`,
    c.gear && c.gear.best ? (c.gear.ref === c.gear.best ? `${c.gear.ref}. Gang` : `Gang ${c.gear.ref} → ${c.gear.best}`) : null,
    rm.brake_m != null && bm.brake_m != null ? `Bremspunkt ${rm.brake_m} → ${bm.brake_m} m vorm Scheitel` : null,
  ].filter(Boolean);
  return h("article", { class: `coach-card${coachState.focus === c.no ? " focus" : ""}`, "data-corner": c.no },
    h("div", { class: "cc-head" },
      h("div", {}, h("span", { class: "cc-rank" }, String(rank + 1)), h("b", {}, `Kurve ${c.no}`),
        h("span", { class: "muted-sm" }, ` · bei ${Math.round(c.apex * 100)} % der Runde`)),
      h("div", { class: "cc-gain" }, `−${secs(c.gain_ms)}`)),
    c.tips.length ? h("ul", { class: "cc-tips" }, c.tips.slice(0, 3).map((t) => h("li", {}, t.text))) : null,
    phaseBar,
    h("div", { class: "cc-facts" }, facts.join(" · ")),
    h("div", { class: "cc-foot" },
      h("span", { class: "muted-sm" }, `Vorbild: Runde ${c.best_lap.lap_number ?? "?"} (${fmt(c.best_lap.lap_time_ms)})`),
      h("button", { class: "ghost", type: "button", onclick: () => compareCorner(c) }, "Im Vergleich ansehen")));
}

function coachTable(corners, top) {
  const maxGain = Math.max(1, ...corners.map((c) => c.gain_ms));
  const topNos = new Set(top.map((c) => c.no));
  const m = (v, unit = "") => (v == null ? "–" : `${Math.round(v)}${unit}`);
  const pair = (a, b, unit) => (a == null && b == null ? "–" : a === b || b == null ? m(a, unit) : h("span", {}, m(a), h("span", { class: "arrow" }, " → "), h("b", {}, m(b, unit))));
  return h("div", { class: "coach-table" }, h("table", {},
    h("thead", {}, h("tr", {},
      h("th", {}, "Kurve"), h("th", {}, "Potenzial"), h("th", { class: "num hide-sm" }, "Streuung"),
      h("th", { class: "num" }, "Scheitel km/h"), h("th", { class: "num" }, "Gang"), h("th", { class: "num hide-sm" }, "Bremse m vorm Scheitel"),
      h("th", { class: "num hide-md" }, "Vollgas m danach"))),
    h("tbody", {}, corners.map((c) => {
      const rm = c.ref_metrics, bm = c.best_metrics, same = c.gain_ms < MIN_GAIN;
      const tr = h("tr", { class: `${topNos.has(c.no) ? "top" : ""}${coachState.focus === c.no ? " focus" : ""}`, "data-corner": c.no, tabindex: 0,
        title: c.tips.length ? c.tips.map((t) => t.text).join(" · ") : "", onclick: () => focusCorner(c.no) },
        h("td", {}, h("span", { class: "cno" }, String(c.no))),
        h("td", {}, h("div", { class: "gainbar" },
          h("span", { class: "gtrack" }, h("span", { style: `width:${Math.max(3, (c.gain_ms / maxGain) * 100)}%`, class: same ? "zero" : "" })),
          h("b", { class: "num" }, same ? "✓" : `−${secs(c.gain_ms, 2)}`))),
        h("td", { class: "num hide-sm" }, `±${secs(c.spread_ms, 2)}`),
        h("td", { class: "num" }, same ? m(rm.v_min) : pair(rm.v_min, bm.v_min)),
        h("td", { class: "num" }, !c.gear || !c.gear.ref ? "–" : same || !c.gear.best || c.gear.ref === c.gear.best ? String(c.gear.ref) : pair(c.gear.ref, c.gear.best)),
        h("td", { class: "num hide-sm" }, same ? m(rm.brake_m) : pair(rm.brake_m, bm.brake_m)),
        h("td", { class: "num hide-md" }, same ? m(rm.full_throttle_m) : pair(rm.full_throttle_m, bm.full_throttle_m)));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") focusCorner(c.no); });
      return tr;
    }))),
    h("div", { class: "muted-sm" }, "Links deine Bestzeit, rechts deine beste Fahrt in dieser Kurve. Streuung = wie sehr die Kurvenzeit von Runde zu Runde schwankt."));
}

function focusCorner(no, force = false) {
  coachState.focus = coachState.focus === no && !force ? null : no;
  renderCornerHistory();
  for (const el of document.querySelectorAll("#coach [data-corner]")) el.classList.toggle("focus", Number(el.dataset.corner) === coachState.focus);
  const c = coachState.data && coachState.data.corners.find((x) => x.no === no);
  if (c && coachState.focus && !document.querySelector(`.coach-card[data-corner="${no}"]`)) {
    // nicht unter den Top 3: Tipp kurz als Tooltip-Zeile zeigen
    const row = document.querySelector(`.coach-table tr[data-corner="${no}"]`);
    if (row && c.tips.length) row.title = c.tips.map((t) => t.text).join(" · ");
  }
}

/** Geometrie für die Karte: Bestzeit-Runde, sonst irgendeine Runde mit Positionen, sonst gelernte Streckenform. */
function coachGeo(d) {
  const has = (l) => l && l.trace.x && l.trace.z && l.trace.x.filter((v) => v != null).length > 100;
  const ref = analysis.traced.find((l) => l.id === d.ref.id);
  return (has(ref) && ref) || analysis.traced.find(has) || analysis.geo || null;
}

function drawCoachMap(box, geo, corners, top) {
  const X = geo.trace.x, Z = geo.trace.z, n = X.length;
  const idx = [...Array(n).keys()].filter((i) => X[i] != null && Z[i] != null);
  const W = box.clientWidth || 500, H = box.clientHeight || 360, pad = 30;
  const xs = idx.map((i) => X[i]), zs = idx.map((i) => Z[i]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const k = Math.min((W - 2 * pad) / Math.max(1, x1 - x0), (H - 2 * pad) / Math.max(1, z1 - z0));
  const ox = (W - (x1 - x0) * k) / 2, oz = (H - (z1 - z0) * k) / 2;
  const P = (i) => { i = ((i % n) + n) % n; return X[i] == null || Z[i] == null ? null : [ox + (X[i] - x0) * k, oz + (Z[i] - z0) * k]; };
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  let d = "";
  for (let i = 0; i < n; i++) { const p = P(i); if (!p) continue; d += `${P(i - 1) && i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`; }
  svg.append(s("path", { class: "map-casing", d }), s("path", { class: "map-base", d }));

  // Kurvenbereich (Anbremsen bis kurz nach dem Scheitel) nach Potenzial färben
  const maxGain = Math.max(1, ...corners.map((c) => c.gain_ms));
  const segs = s("g", { class: "map-segs" });
  for (const c of corners) {
    if (c.gain_ms < MIN_GAIN) continue;
    const a = Math.round(c.start * n), ap = Math.round(c.apex * n);
    const e = ap + Math.min(8, Math.round((((c.end - c.apex) % 1 + 1) % 1) * n / 2));
    const col = mixRgb(MAP_NEUTRAL, MAP_LOSS, 0.35 + 0.65 * Math.sqrt(c.gain_ms / maxGain));
    const len = ((e - a) % n + n) % n;
    for (let j = 0; j < len; j++) {
      const p = P(a + j), q = P(a + j + 1);
      if (p && q) segs.append(s("line", { x1: p[0].toFixed(1), y1: p[1].toFixed(1), x2: q[0].toFixed(1), y2: q[1].toFixed(1), stroke: col }));
    }
  }
  svg.append(segs);

  // Start/Ziel
  const cx = W / 2, cy = H / 2;
  const outward = (i) => {
    const p = P(i), q = P(i + 2) || P(i - 2) || p;
    let nx = -(q[1] - p[1]), ny = q[0] - p[0];
    const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
    if ((p[0] - cx) * nx + (p[1] - cy) * ny < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  };
  const s0 = idx[0];
  if (s0 != null && s0 <= 2) {
    const p = P(s0), [nx, ny] = outward(s0);
    svg.append(s("line", { class: "map-start", x1: p[0] - nx * 9, y1: p[1] - ny * 9, x2: p[0] + nx * 9, y2: p[1] + ny * 9 }));
  }
  // Nummern am Scheitel, nach außen versetzt
  const topNos = new Set(top.map((c) => c.no));
  for (const c of corners) {
    const i = Math.round(c.apex * n), p = P(i);
    if (!p) continue;
    const [nx, ny] = outward(i), off = 20;
    const g = s("g", { class: `cmark${topNos.has(c.no) ? " top" : ""}${c.gain_ms < MIN_GAIN ? " ok" : ""}${coachState.focus === c.no ? " focus" : ""}`, "data-corner": c.no });
    g.append(s("line", { class: "stem", x1: p[0], y1: p[1], x2: p[0] + nx * (off - 10), y2: p[1] + ny * (off - 10) }),
      s("circle", { cx: p[0] + nx * off, cy: p[1] + ny * off, r: 10.5 }));
    const t = s("text", { x: p[0] + nx * off, y: p[1] + ny * off + 4, "text-anchor": "middle" });
    t.textContent = String(c.no);
    g.append(t);
    g.addEventListener("click", () => focusCorner(c.no));
    svg.append(g);
  }
  box.replaceChildren(svg);
}
