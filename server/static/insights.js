// SimDash – Auto-Insights: eine Runde Kurve für Kurve gegen eine Referenz (Daten: /api/coach/lap).
// Wird im Live-Tab (nach jeder Runde) und im Rundenvergleich benutzt. Globale Helfer aus app.js.
"use strict";

const INS_MIN = 30;                                   // ab so vielen ms zählt ein Verlust
const insCache = new Map();

async function fetchInsights(id, refId) {
  const key = `${id}|${refId || ""}`;
  if (insCache.has(key)) return insCache.get(key);
  const q = new URLSearchParams({ id });
  if (refId) q.set("ref_id", refId);
  const d = await getJSON(`/api/coach/lap?${q}`);
  if (insCache.size > 40) insCache.clear();
  insCache.set(key, d);
  return d;
}

function insSecs(ms, digits = 2) {
  const txt = (Math.abs(ms) / 1000).toFixed(digits).replace(".", ",");
  return `${/^[0,]+$/.test(txt) ? "±" : ms < 0 ? "−" : "+"}${txt} s`;
}

/** Vier Phasen als kleine Zellen: rot = dort verloren, blau = dort gewonnen. */
function phaseCells(phases, title) {
  return h("div", { class: "ph-cells", title: title || "" }, phases.map((p) => {
    const v = p.ms;
    const cls = v == null ? "" : v >= INS_MIN / 2 ? "loss" : v <= -INS_MIN / 2 ? "gain" : "even";
    return h("div", { class: `ph-cell ${cls}` }, h("span", {}, p.label), h("b", {}, v == null ? "–" : insSecs(v)));
  }));
}

/** Linienvergleich: deine Linie (blau) gegen die Referenz (orange), auf die Kurve gezoomt. */
function lineSvg(line) {
  const all = [...line.lap, ...line.ref];
  const xs = all.map((p) => p[0]), zs = all.map((p) => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const span = Math.max(x1 - x0, z1 - z0, 20), pad = span * 0.08;
  const W = 260, H = 200;
  const k = Math.min(W / (x1 - x0 + 2 * pad), H / (z1 - z0 + 2 * pad));
  const ox = (W - (x1 - x0) * k) / 2, oz = (H - (z1 - z0) * k) / 2;
  const pt = (p) => `${((p[0] - x0) * k + ox).toFixed(1)},${((p[1] - z0) * k + oz).toFixed(1)}`;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "ins-line", role: "img", "aria-label": "Fahrlinie: blau du, orange Referenz" });
  svg.append(s("polyline", { points: line.ref.map(pt).join(" "), class: "ln-ref" }));
  svg.append(s("polyline", { points: line.lap.map(pt).join(" "), class: "ln-lap" }));
  const st = line.lap[0];
  const dot = s("circle", { cx: pt(st).split(",")[0], cy: pt(st).split(",")[1], r: 3.5, class: "ln-start" });
  svg.append(dot);
  if (line.apex_point) {
    const [ax, ay] = pt(line.apex_point).split(",");
    svg.append(s("circle", { cx: ax, cy: ay, r: 6, class: "ln-apex" }));
  }
  // Maßstab: runde Meterzahl, ca. ein Viertel der Breite
  const m = [5, 10, 20, 25, 50, 100, 200].find((x) => x * k >= W / 5) || 200;
  svg.append(s("line", { x1: 8, y1: H - 8, x2: 8 + m * k, y2: H - 8, class: "ln-scale" }));
  const t = s("text", { x: 8, y: H - 13, class: "ln-scale-t" }); t.textContent = `${m} m`; svg.append(t);
  return svg;
}

function insCard(c, rank) {
  const lm = c.lap_metrics || {}, rm = c.ref_metrics || {};
  const facts = [
    lm.v_min != null && rm.v_min != null ? `Scheitel ${Math.round(lm.v_min)} / ${Math.round(rm.v_min)} km/h` : null,
    lm.v_exit != null && rm.v_exit != null ? `Ausgang ${Math.round(lm.v_exit)} / ${Math.round(rm.v_exit)} km/h` : null,
    lm.brake_m != null && rm.brake_m != null ? `Bremspunkt ${lm.brake_m} / ${rm.brake_m} m vorm Scheitel` : null,
    lm.gear && rm.gear && lm.gear !== rm.gear ? `Gang ${lm.gear} / ${rm.gear}` : null,
  ].filter(Boolean);
  const off = c.line && c.line.apex_offset_m;
  const lineTxt = off != null && Math.abs(off) >= 0.5
    ? `Linie: am Scheitel ${Math.abs(off).toFixed(1).replace(".", ",")} m weiter ${off > 0 ? "innen" : "außen"} als die Referenz` : null;
  const lineBox = h("div", { class: "ins-linebox" });
  const btn = c.line ? h("button", { class: "ghost", type: "button", "aria-expanded": "false" }, "Linie zeigen") : null;
  if (btn) btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    btn.textContent = open ? "Linie zeigen" : "Linie ausblenden";
    lineBox.replaceChildren(...(open ? [] : [lineSvg(c.line),
      h("div", { class: "legend" }, h("span", { class: "key" }, h("i", { class: "ln-k lap" }), "du"),
        h("span", { class: "key" }, h("i", { class: "ln-k ref" }), "Referenz"), h("span", { class: "key muted" }, "● Start · ○ Scheitel"))]));
  });
  return h("article", { class: "coach-card ins-card", "data-corner": c.no },
    h("div", { class: "cc-head" },
      h("div", {}, rank != null ? h("span", { class: "cc-rank" }, String(rank + 1)) : null, h("b", {}, `Kurve ${c.no}`),
        h("span", { class: "muted-sm" }, ` · ${Math.round(c.apex * 100)} % der Runde`)),
      h("div", { class: c.loss_ms >= 0 ? "cc-gain" : "cc-gain gain" }, insSecs(c.loss_ms, 3))),
    c.tips && c.tips.length ? h("ul", { class: "cc-tips" }, c.tips.slice(0, 3).map((t) => h("li", {}, t.text))) : null,
    phaseCells(c.phases, "Verlust je Phase gegen die Referenz"),
    facts.length ? h("div", { class: "cc-facts" }, `du / Referenz: ${facts.join(" · ")}`) : null,
    lineTxt ? h("div", { class: "cc-facts" }, lineTxt) : null,
    btn ? h("div", { class: "cc-foot" }, btn) : null, lineBox);
}

/**
 * Auswertung in box zeichnen.  opts.compact: nur die 2 größten Baustellen (Live-Tab),
 * opts.title: Überschrift davor.
 */
function renderInsights(box, d, opts = {}) {
  if (!d) { box.replaceChildren(); return; }
  if (!d.ok) {
    const why = {
      no_trace: "Für diese Runde gibt es keinen brauchbaren Verlauf (Tempo, Pedale), daher keine Auswertung.",
      no_reference: "Noch keine zweite Runde mit diesem Auto hier – nach der nächsten Runde vergleicht der Coach.",
    }[d.reason] || "Keine Auswertung möglich.";
    box.replaceChildren(h("p", { class: "analysis-empty" }, why));
    return;
  }
  const lost = d.corners.filter((c) => c.loss_ms >= INS_MIN).sort((a, b) => b.loss_ms - a.loss_ms);
  const gained = d.corners.filter((c) => c.loss_ms <= -INS_MIN).sort((a, b) => a.loss_ms - b.loss_ms);
  const refName = { pb: "deine Bestzeit", previous_pb: "deine vorherige Bestzeit", next_best: "deine nächstbeste Runde" }[d.ref_kind]
    || `Runde ${d.ref.lap_number ?? "?"}${d.ref.driver && d.lap.driver && d.ref.driver !== d.lap.driver ? ` von ${d.ref.driver}` : ""}`;
  const newPb = d.delta_ms < 0 && d.ref_kind === "previous_pb" && d.lap_counts;
  const head = h("div", { class: "ins-head" },
    h("div", {}, h("b", {}, `Runde ${d.lap.lap_number ?? "?"} · ${fmt(d.lap.lap_time_ms)}`),
      h("span", { class: d.delta_ms > 0 ? "ins-delta loss" : "ins-delta gain" }, ` ${insSecs(d.delta_ms, 3)}`),
      h("span", { class: "muted-sm" }, ` gegen ${refName} (${fmt(d.ref.lap_time_ms)})`)),
    newPb ? h("span", { class: "ins-pb" }, "Neue Bestzeit") : null);

  // Wo verlierst du generell? Summe je Phase über alle Kurven
  const tot = d.phase_totals || [];
  const worstPh = tot.filter((p) => p.ms >= INS_MIN * 3).sort((a, b) => b.ms - a.ms)[0];
  const summary = h("div", { class: "ins-sum" },
    h("div", { class: "subchart-title" }, "Wo die Zeit liegt (alle Kurven)"), phaseCells(tot),
    worstPh ? h("p", { class: "muted-sm" }, `Die meiste Zeit liegt im ${worstPh.label === "Ausgang" ? "Ausgang und auf den Geraden danach" : worstPh.label}: ${insSecs(worstPh.ms)} über die Runde.`) : null);

  // Sprungliste: alle Problemkurven als Chips, angetippt zeigt die Karte darunter
  const cardBox = h("div", { class: "coach-cards" });
  const showCards = (list) => cardBox.replaceChildren(...list.map((c, k) => insCard(c, list.length > 1 ? k : null)));
  const nTop = opts.compact ? 2 : 3;
  const chips = lost.length > nTop || gained.length ? h("div", { class: "chips ins-chips" },
    lost.map((c) => {
      const b = h("button", { class: "chip loss", type: "button" }, `K${c.no} ${insSecs(c.loss_ms)}`);
      b.addEventListener("click", () => showCards([c]));
      return b;
    }),
    gained.map((c) => {
      const b = h("button", { class: "chip gain", type: "button" }, `K${c.no} ${insSecs(c.loss_ms)}`);
      b.addEventListener("click", () => showCards([c]));
      return b;
    })) : null;
  if (lost.length) showCards(lost.slice(0, nTop));
  else cardBox.replaceChildren(h("p", { class: "analysis-empty" }, d.delta_ms <= 0
    ? "In keiner Kurve langsamer als die Referenz. Stark!"
    : "Kein einzelner Fehler: die Zeit verteilt sich auf viele kleine Stellen."));

  box.replaceChildren(...[opts.title ? h("div", { class: "subchart-title" }, opts.title) : null, head,
    opts.compact ? null : summary, chips, cardBox].filter(Boolean));
}
