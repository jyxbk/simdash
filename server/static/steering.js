"use strict";
// ---------------------------------------------------------------------------
// Coach & Setup → Lenkung: Einlenkpunkt, Aufmachen, Einschlag, Korrekturen, Gegenlenken je Kurve,
// du (Bestzeit-Runde) gegen deine schnellste Fahrt durch die Kurve. Daten: /api/coach (corner.steer),
// Verläufe aus analysis.traced. Nutzt h/$/drawXY/cornerLabel aus app.js, coachState aus coach.js.
// ---------------------------------------------------------------------------
const steerState = { sel: null, chart: null };
const TECH_GROUPS = [
  { key: "brake", title: "1 · Anbremsen", rule: "Hart und gerade anbremsen: Bremsdruck schnell aufbauen, solange das Auto noch gerade ist.",
    kinds: ["brake_build", "brake_later", "brake_earlier", "entry_speed"] },
  { key: "turnin", title: "2 · Einlenken & Trail-Braking", rule: "Je mehr Lenkung, desto weniger Bremse: beim Einlenken die Bremse schrittweise lösen. Einmal sauber einlenken statt nachkorrigieren.",
    kinds: ["trail_more", "less_brake_lock", "turn_in_later", "turn_in_earlier", "fewer_corrections", "steer_calmer", "less_lock"] },
  { key: "apex", title: "3 · Scheitel", rule: "Nicht rollen: zwischen Bremse und Gas keine Lücke. Tempo mitnehmen, in schnellen Kurven voll bleiben, wo es geht.",
    kinds: ["coast_less", "carry_speed", "lift_brief", "lift_softer", "flat_out"] },
  { key: "exit", title: "4 · Ausgang", rule: "Gas anlegen, sobald du nicht weiter einlenkst; Vollgas erst mit aufgehender Lenkung. Gleichmäßig aufbauen, nicht pumpen.",
    kinds: ["throttle_pickup", "throttle_earlier", "throttle_smooth", "less_throttle_lock", "unwind_earlier", "better_exit", "no_countersteer", "gear_higher", "gear_lower"] },
];
const TECH_KINDS = new Set(TECH_GROUPS.flatMap((g) => g.kinds));

function renderSteering() {
  const box = $("#steering-body");
  if (!box || currentPage() !== "coach" || coachSub() !== "technik") return;
  const d = coachState.data;
  if (!d || !d.corners) { box.replaceChildren(h("p", { class: "muted-sm" }, "Lädt …")); return; }
  if (!d.corners.length || (d.laps_used || 0) < 2) {
    box.replaceChildren(h("p", {}, "Für die Fahrtechnik braucht es mindestens zwei gültige Runden mit diesem Auto auf dieser Strecke."));
    return;
  }
  // Je Abschnitt: in welchen Kurven weicht deine Bestzeit-Runde von deiner schnellsten Fahrt ab?
  const cards = TECH_GROUPS.map((g) => {
    const hits = d.corners.map((c) => ({ c, t: (c.tips || []).filter((t) => g.kinds.includes(t.kind)) })).filter((x) => x.t.length)
      .sort((a, b) => b.c.gain_ms - a.c.gain_ms);
    return h("article", { class: `tech-card ${hits.length ? "warn" : "ok"}` },
      h("div", { class: "tech-h" }, h("b", {}, g.title), h("span", { class: hits.length ? "warn-ic" : "ok-ic" }, hits.length ? `${hits.length} ${hits.length === 1 ? "Kurve" : "Kurven"}` : "✓ passt")),
      h("p", { class: "muted-sm" }, g.rule),
      hits.length ? h("ul", {}, ...hits.slice(0, 4).map((x) => h("li", { style: "cursor:pointer", onclick: () => { steerState.sel = x.c.no; renderSteering(); } },
        h("b", {}, `${cornerShort(x.c)}: `), x.t[0].text))) : null);
  });
  const rows = d.corners.filter((c) => c.steer || c.ref_metrics);
  const R = (c) => (c.steer ? c.steer.ref : c.ref_metrics) || {};
  const B = (c) => (c.steer ? c.steer.best : c.best_metrics) || {};
  const v = (x, suf = "") => (x == null ? "–" : `${x}${suf}`);
  const pair = (a, b, suf = "") => h("span", { class: "pair" }, h("b", {}, v(a, suf)), h("span", { class: "muted" }, ` / ${v(b, suf)}`));
  const head = (t, span) => h("th", { colspan: span, class: "grp" }, t);
  const table = h("div", { class: "table-wrap" }, h("table", { class: "ct steer-t num" },
    h("thead", {},
      h("tr", {}, h("th", {}, ""), head("Bremse", 3), head("Lenkung", 3), head("Scheitel", 1), head("Gas", 3), h("th", {}, "")),
      h("tr", {}, ...["Kurve", "Aufbau", "am Einlenken", "Trail", "Einlenken", "Korrekt.", "Aufmachen", "Rollen", "Anlegen", "bei max. Lenkung", "Lupfer", "Wichtigster Tipp"].map((x) => h("th", {}, x)))),
    h("tbody", {}, ...rows.map((c) => {
      const r = R(c), b = B(c);
      const tip = (c.tips || [])[0];
      return h("tr", { class: steerState.sel === c.no ? "sel" : "", style: "cursor:pointer", onclick: () => { steerState.sel = c.no; renderSteering(); } },
        h("td", {}, h("b", {}, cornerLabel(c)), h("div", { class: "muted-sm" }, c.gain_ms >= 30 ? `−${(c.gain_ms / 1000).toFixed(2).replace(".", ",")} s` : "")),
        h("td", {}, pair(r.brake_build_m, b.brake_build_m, " m")), h("td", {}, pair(r.brake_at_turnin, b.brake_at_turnin, " %")),
        h("td", {}, pair(r.trail_m, b.trail_m, " m")),
        h("td", {}, pair(r.turn_in_m, b.turn_in_m, " m")), h("td", {}, pair(r.corrections, b.corrections)),
        h("td", {}, pair(r.unwind_m, b.unwind_m, " m")),
        h("td", {}, pair(r.coast_m, b.coast_m, " m")),
        h("td", {}, pair(r.pickup_m, b.pickup_m, " m")), h("td", {}, pair(r.thr_at_steer_peak, b.thr_at_steer_peak, " %")),
        h("td", {}, pair(r.thr_lifts, b.thr_lifts)),
        h("td", { class: "tip-cell" }, tip && c.gain_ms >= 30 ? tip.text : h("span", { class: "muted" }, "passt")));
    }))));
  if (steerState.sel == null || !rows.some((c) => c.no === steerState.sel)) {
    const withTip = rows.filter((c) => (c.tips || []).some((t) => TECH_KINDS.has(t.kind))).sort((a, b) => b.gain_ms - a.gain_ms);
    steerState.sel = (withTip[0] || rows[0]).no;
  }
  const sel = rows.find((c) => c.no === steerState.sel);
  const charts = h("div", { class: "tech-charts" },
    ...[["brk", "Bremse %"], ["st", "Lenkung %"], ["thr", "Gas %"]].map(([k, t]) => h("div", {}, h("div", { class: "muted-sm" }, t), h("div", { class: "steer-chart", "data-k": k }))));
  const selTips = (sel.tips || []).filter((t) => sel.gain_ms >= 30);
  box.replaceChildren(
    h("div", { class: "tech-grid" }, ...cards),
    h("div", { class: "subchart-title", style: "margin-top:16px" }, `${cornerLabel(sel)} im Detail`),
    selTips.length ? h("ol", { class: "steps" }, ...selTips.map((t) => h("li", {}, h("span", {}, t.text), h("span", { class: "pill" }, techGroupOf(t.kind))))) :
      h("p", { class: "muted-sm" }, "Hier fährst du schon wie in deiner schnellsten Fahrt – kein Tipp."),
    h("div", { class: "legend" }, h("span", { class: "key" }, h("i", { class: "swatch", style: "background:var(--series-1)" }), "deine Bestzeit-Runde"),
      h("span", { class: "key" }, h("i", { class: "swatch", style: "background:var(--series-2)" }), sel.steer && sel.steer.newer ? "schnellste neuere Fahrt dort" : "schnellste Fahrt dort"),
      h("span", { class: "key muted" }, "x = Verlauf durch die Kurve · antippen zeigt Meter zum Scheitel")),
    charts,
    h("p", { class: "muted-sm" }, "Erste Zahl = deine Bestzeit-Runde, zweite = schnellste Fahrt durch die Kurve. Trail = Meter mit Bremse und Lenkung gleichzeitig; Rollen = Meter ohne Pedal; Anlegen = Meter nach dem Scheitel, an denen das Gas kommt (negativ: davor). Zeile antippen für Details."),
    table);
  requestAnimationFrame(() => { for (const el of charts.querySelectorAll("[data-k]")) drawSteerChart(el, sel, d, el.dataset.k); });
}

function techGroupOf(kind) {
  const g = TECH_GROUPS.find((x) => x.kinds.includes(kind));
  return g ? g.title.split("· ")[1] : "Allgemein";
}

function drawSteerChart(box, c, d, key = "st") {
  const ids = c.steer ? [c.steer.ref_id, c.steer.best_id] : [state.detail && state.detail.pb && state.detail.pb.id, c.best_lap && c.best_lap.id];
  const lapA = (analysis.traced || []).find((l) => l.id === ids[0]);
  const lapB = (analysis.traced || []).find((l) => l.id === ids[1]);
  if (!lapA || !lapA.trace[key]) { box.replaceChildren(h("p", { class: "muted-sm" }, "Verlauf dieser Runde nicht geladen.")); return; }
  const n = lapA.trace[key].length, mPer = (d.track_length_m || 4000) / n;
  const a = Math.floor(c.start * n), e = Math.ceil(c.end * n), apex = Math.round(c.apex * n);
  const span = ((e - a + n) % n) || n;
  const idx = Array.from({ length: span + 1 }, (_, k) => (a + k) % n);
  const xsM = idx.map((i) => { let dd = i - apex; if (dd > n / 2) dd -= n; if (dd < -n / 2) dd += n; return dd * mPer; });
  const lo = Math.min(...xsM), hi = Math.max(...xsM);
  const xs = xsM.map((v) => (v - lo) / Math.max(1, hi - lo));
  const f = key === "st" ? 100 : 1;
  const vals = (l) => (l && l.trace[key] ? idx.map((i) => (l.trace[key][i] == null ? null : l.trace[key][i] * f)) : null);
  let va = vals(lapA), vb = vals(lapB);
  const sum = va.reduce((s0, v) => s0 + (v || 0), 0);
  if (key === "st" && sum < 0) { va = va.map((v) => (v == null ? null : -v)); if (vb) vb = vb.map((v) => (v == null ? null : -v)); }   // Kurvenrichtung nach oben
  const series = [vb ? { values: vb, color: "var(--series-2)" } : null, { values: va, color: "var(--series-1)" }].filter(Boolean);
  box.replaceChildren();
  drawXY(box, { xs, series, zero: true, yFmt: (v) => `${Math.round(v)}`, tip: (i) => [
    h("b", {}, `${Math.round(xsM[i])} m ${xsM[i] < 0 ? "vor" : "nach"} dem Scheitel`), h("br"),
    `du ${va[i] == null ? "–" : Math.round(va[i]) + " %"}`, vb ? ` · schnellste ${vb[i] == null ? "–" : Math.round(vb[i]) + " %"}` : ""] });
}

window.addEventListener("resize", () => { if (currentPage() === "coach" && coachSub() === "technik") renderSteering(); });
