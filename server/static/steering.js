"use strict";
// ---------------------------------------------------------------------------
// Coach & Setup → Lenkung: Einlenkpunkt, Aufmachen, Einschlag, Korrekturen, Gegenlenken je Kurve,
// du (Bestzeit-Runde) gegen deine schnellste Fahrt durch die Kurve. Daten: /api/coach (corner.steer),
// Verläufe aus analysis.traced. Nutzt h/$/drawXY/cornerLabel aus app.js, coachState aus coach.js.
// ---------------------------------------------------------------------------
const steerState = { sel: null, chart: null };
const STEER_KINDS = { turn_in_later: "später einlenken", turn_in_earlier: "früher einlenken", unwind_earlier: "früher aufmachen",
  fewer_corrections: "weniger korrigieren", no_countersteer: "Gegenlenken vermeiden", steer_calmer: "ruhiger lenken", less_lock: "weniger einschlagen" };

function renderSteering() {
  const box = $("#steering-body");
  if (!box || currentPage() !== "coach" || coachSub() !== "lenkung") return;
  const d = coachState.data;
  if (!d || !d.corners) { box.replaceChildren(h("p", { class: "muted-sm" }, "Lädt …")); return; }
  const rows = d.corners.filter((c) => c.steer);
  if (!rows.length) {
    box.replaceChildren(h("p", {}, "Für diese Kombination gibt es noch keine Runden mit Lenkdaten (ab Collector 0.6). Einfach fahren – ab der nächsten Session ist der Vergleich da."));
    return;
  }
  // Zusammenfassung: welche Lenk-Tipps kommen wie oft vor?
  const count = {};
  let lost = 0;
  for (const c of d.corners) {
    const ks = (c.tips || []).map((t) => t.kind).filter((k) => STEER_KINDS[k]);
    for (const k of ks) count[k] = (count[k] || 0) + 1;
    if (ks.length) lost += c.gain_ms || 0;
  }
  const top = Object.entries(count).sort((a, b) => b[1] - a[1]);
  const summary = top.length
    ? h("p", {}, `In ${d.corners.filter((c) => (c.tips || []).some((t) => STEER_KINDS[t.kind])).length} von ${d.corners.length} Kurven lenkst du anders als bei deiner schnellsten Fahrt dort (zusammen bis ${(lost / 1000).toFixed(2).replace(".", ",")} s). Häufigstes Muster: `,
      h("b", {}, top.slice(0, 2).map(([k, n]) => `${STEER_KINDS[k]} (${n}×)`).join(", ")), ".")
    : h("p", {}, "✓ Deine Lenkung entspricht in allen Kurven ungefähr deiner schnellsten Fahrt. Die Zeit liegt woanders (Bremsen, Tempo, Gas).");
  const cs = rows.filter((c) => c.steer.ref.countersteer).map((c) => cornerShort(c));
  const fmtM = (v) => (v == null ? "–" : `${v} m`);
  const pair = (a, b, f) => h("span", { class: "pair" }, h("b", {}, f(a)), h("span", { class: "muted" }, ` / ${f(b)}`));
  const table = h("div", { class: "table-wrap" }, h("table", { class: "ct steer-t num" },
    h("thead", {}, h("tr", {}, ...["Kurve", "Einlenken vor Scheitel", "Aufmachen nach Scheitel", "Max. Einschlag", "Korrekturen", "Gegenlenken", "Tipp"].map((x) => h("th", {}, x)))),
    h("tbody", {}, ...rows.map((c) => {
      const r = c.steer.ref, b = c.steer.best;
      const tip = (c.tips || []).find((t) => STEER_KINDS[t.kind]);
      return h("tr", { class: steerState.sel === c.no ? "sel" : "", style: "cursor:pointer", onclick: () => { steerState.sel = c.no; renderSteering(); } },
        h("td", {}, h("b", {}, cornerLabel(c))),
        h("td", {}, pair(r.turn_in_m, b.turn_in_m, fmtM)),
        h("td", {}, pair(r.unwind_m, b.unwind_m, fmtM)),
        h("td", {}, pair(r.steer_peak, b.steer_peak, (v) => (v == null ? "–" : `${Math.round(v * 100)} %`))),
        h("td", {}, pair(r.corrections, b.corrections, (v) => (v == null ? "–" : String(v)))),
        h("td", {}, r.countersteer ? h("span", { class: "warn-ic" }, "⚠ ja") : "–"),
        h("td", { class: "tip-cell" }, tip ? tip.text : h("span", { class: "muted" }, "passt")));
    }))));
  if (steerState.sel == null || !rows.some((c) => c.no === steerState.sel)) {
    const withTip = rows.filter((c) => (c.tips || []).some((t) => STEER_KINDS[t.kind])).sort((a, b) => b.gain_ms - a.gain_ms);
    steerState.sel = (withTip[0] || rows[0]).no;
  }
  const sel = rows.find((c) => c.no === steerState.sel);
  const chartBox = h("div", { class: "steer-chart", id: "steer-chart" });
  box.replaceChildren(summary,
    cs.length ? h("p", { class: "warn-ic" }, `⚠ Gegenlenken (Heck kommt) in ${cs.join(", ")} – dort zuerst Gas und Lenkung entkoppeln.`) : "",
    h("div", { class: "subchart-title", style: "margin-top:12px" }, `Lenkverlauf ${cornerLabel(sel)}`),
    h("div", { class: "legend" }, h("span", { class: "key" }, h("i", { class: "swatch", style: "background:var(--series-1)" }), "deine Bestzeit-Runde"),
      h("span", { class: "key" }, h("i", { class: "swatch", style: "background:var(--series-2)" }), sel.steer.newer ? "schnellste neuere Fahrt dort" : "schnellste Fahrt dort"),
      h("span", { class: "key muted" }, "x = Verlauf durch die Kurve (Start → Ende), y = Einschlag in % · antippen zeigt Meter zum Scheitel")),
    chartBox,
    h("p", { class: "muted-sm" }, "Zeile antippen für den Verlauf einer anderen Kurve. Einlenken = Lenkung erreicht 35 % des Maximums der Kurve, Aufmachen = fällt wieder unter 50 %. Korrekturen = Nachlenken um mehr als 8 % des Maximums."),
    table);
  requestAnimationFrame(() => drawSteerChart(chartBox, sel, d));
}

function drawSteerChart(box, c, d) {
  const lapA = (analysis.traced || []).find((l) => l.id === c.steer.ref_id);
  const lapB = (analysis.traced || []).find((l) => l.id === c.steer.best_id);
  if (!lapA || !lapA.trace.st) { box.replaceChildren(h("p", { class: "muted-sm" }, "Verlauf dieser Runde nicht geladen.")); return; }
  const n = lapA.trace.st.length, mPer = (d.track_length_m || 4000) / n;
  const a = Math.floor(c.start * n), e = Math.ceil(c.end * n), apex = Math.round(c.apex * n);
  const span = ((e - a + n) % n) || n;
  const idx = Array.from({ length: span + 1 }, (_, k) => (a + k) % n);
  const xsM = idx.map((i) => { let dd = i - apex; if (dd > n / 2) dd -= n; if (dd < -n / 2) dd += n; return dd * mPer; });
  const lo = Math.min(...xsM), hi = Math.max(...xsM);
  const xs = xsM.map((v) => (v - lo) / Math.max(1, hi - lo));
  const vals = (l) => (l && l.trace.st ? idx.map((i) => (l.trace.st[i] == null ? null : l.trace.st[i] * 100)) : null);
  let va = vals(lapA), vb = vals(lapB);
  const sum = va.reduce((s0, v) => s0 + (v || 0), 0);
  if (sum < 0) { va = va.map((v) => (v == null ? null : -v)); if (vb) vb = vb.map((v) => (v == null ? null : -v)); }   // Kurvenrichtung nach oben
  const series = [vb ? { values: vb, color: "var(--series-2)" } : null, { values: va, color: "var(--series-1)" }].filter(Boolean);
  box.replaceChildren();
  drawXY(box, { xs, series, zero: true, yFmt: (v) => `${Math.round(v)}`, tip: (i) => [
    h("b", {}, `${Math.round(xsM[i])} m ${xsM[i] < 0 ? "vor" : "nach"} dem Scheitel`), h("br"),
    `du ${va[i] == null ? "–" : Math.round(va[i]) + " %"}`, vb ? ` · schnellste ${vb[i] == null ? "–" : Math.round(vb[i]) + " %"}` : ""] });
}

window.addEventListener("resize", () => { if (currentPage() === "coach" && coachSub() === "lenkung") renderSteering(); });
