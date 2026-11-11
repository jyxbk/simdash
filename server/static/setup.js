"use strict";
// ---------------------------------------------------------------------------
// Coach & Setup: Setup-Logbuch (vorher/nachher) und Reifen & Bremsen.
// Nutzt state/analysis/coachState aus app.js/coach.js und h/$/fmt/pretty/getJSON.
// ---------------------------------------------------------------------------
const setupState = { key: null, changes: [], stats: null, statsKey: null };
const PARTS = ["Reifendruck", "Sturz", "Spur", "Stabilisator vorne", "Stabilisator hinten", "Federn", "Dämpfer", "Bodenfreiheit",
  "Flügel / Aero", "Differenzial", "Bremsbalance", "Bremsdruck", "TC", "ABS", "Übersetzung", "Sonstiges"];
const WHEELS = ["Vorne links", "Vorne rechts", "Hinten links", "Hinten rechts"];
const nf = (v, d = 1) => v == null ? "–" : Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });

function curCombo() {
  return (state.bests || []).find((b) => comboKey(b) === state.selected) || null;
}
const comboParams = (c) => new URLSearchParams({ game: c.game, track: c.track, layout: c.layout, car: c.car });

/* --- Logbuch --------------------------------------------------------------- */
async function loadSetupChanges(c) {
  setupState.changes = await getJSON(`/api/setup_changes?${comboParams(c)}`).catch(() => []);
  setupState.key = comboKey(c);
}

function lapsBetween(laps, from, to) {
  return laps.filter((l) => (!from || l.recorded_at > from) && (!to || l.recorded_at <= to)
    && !l.outlap && !l.inlap && !l.estimated);
}
function metrics(laps) {
  const val = laps.filter((l) => l.valid !== false).map((l) => l.lap_time_ms).sort((a, b) => a - b);
  if (val.length < 3) return { n: laps.length, ok: false };
  const med = val[Math.floor(val.length / 2)];
  const mad = [...val.map((x) => Math.abs(x - med))].sort((a, b) => a - b)[Math.floor(val.length / 2)];
  return { n: laps.length, ok: true, best: val[0], median: med, spread: mad, inv: Math.round(100 * laps.filter((l) => l.valid === false).length / laps.length) };
}

function renderSetupLog() {
  const box = $("#setup-log-body");
  const c = curCombo();
  if (!c || !state.detail) { box.replaceChildren(h("p", { class: "muted-sm" }, "Lädt …")); return; }
  const laps = state.detail.laps;
  const ch = setupState.changes;
  const form = h("form", { class: "sl-form", onsubmit: addChange },
    h("label", {}, "Bauteil", h("select", { name: "part", class: "input" }, ...PARTS.map((p) => h("option", {}, p)))),
    h("label", {}, "Vorher", h("input", { name: "before", class: "input", maxlength: 40, placeholder: "z. B. 5" })),
    h("label", {}, "Nachher", h("input", { name: "after", class: "input", maxlength: 40, placeholder: "z. B. 4" })),
    h("label", { class: "wide" }, "Notiz", h("input", { name: "note", class: "input", maxlength: 300, placeholder: "z. B. gegen Schieben am Ausgang K5" })),
    h("button", { type: "submit", class: "btn primary" }, "Eintragen"),
    h("div", { class: "sl-err", id: "sl-err", role: "alert" }));
  const items = ch.slice().reverse().map((x) => {
    const idx = ch.indexOf(x);
    const prevAt = idx > 0 ? ch[idx - 1].at : null, nextAt = idx < ch.length - 1 ? ch[idx + 1].at : null;
    const a = metrics(lapsBetween(laps, prevAt, x.at)), b = metrics(lapsBetween(laps, x.at, nextAt));
    return h("article", { class: "sl-item" },
      h("div", { class: "sl-head" },
        h("div", {}, h("b", {}, x.part), x.before || x.after ? ` ${x.before || "?"} → ${x.after || "?"}` : "",
          h("div", { class: "muted-sm" }, `${fmtDate(x.at)}${x.driver ? " · " + x.driver : ""}${x.note ? " · " + x.note : ""}`)),
        h("button", { class: "ghost sm", type: "button", title: "Eintrag löschen", onclick: () => delChange(x.id) }, "Löschen")),
      abTable(a, b));
  });
  box.replaceChildren(form, items.length ? h("div", { class: "sl-list" }, ...items) :
    h("p", { class: "muted-sm" }, "Noch keine Änderung eingetragen. Ablauf: 5 saubere Runden als Basis → eine Änderung eintragen → wieder 5 saubere Runden → SimDash vergleicht."));
}

function abTable(a, b) {
  if (!a.ok || !b.ok) {
    return h("p", { class: "muted-sm" }, `Für den Vergleich braucht es vorher und nachher je mindestens 3 gültige Runden (vorher ${a.n}, nachher ${b.n} gewertete Runden).`);
  }
  const row = (label, va, vb, f, fd) => {
    const d = vb - va, better = d < 0;
    return h("tr", {}, h("td", {}, label), h("td", { class: "n" }, f(va)), h("td", { class: "n" }, f(vb)),
      h("td", { class: `n d ${d === 0 ? "" : better ? "better" : "worse"}` }, d === 0 ? "±0" : `${better ? "▲" : "▼"} ${fd(Math.abs(d))}`));
  };
  const sec = (v) => `${(v / 1000).toFixed(3).replace(".", ",")} s`;
  const md = b.median - a.median;
  const verdict = md < -100 && b.inv <= a.inv + 10 ? ["good", "Hat sich gelohnt: im Mittel schneller, nicht unsauberer."]
    : md > 100 ? ["crit", "Eher schlechter: im Mittel langsamer. Zurückstellen oder andersherum probieren."]
      : ["", "Kein klarer Unterschied (unter 0,1 s im Mittel). Mehr Runden fahren oder größeren Schritt testen."];
  return h("div", {},
    h("div", { class: "table-wrap" }, h("table", { class: "ct ab num" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", { class: "n" }, `vorher (${a.n})`), h("th", { class: "n" }, `nachher (${b.n})`), h("th", { class: "n" }, "Wirkung"))),
      h("tbody", {}, row("Bestzeit", a.best, b.best, fmt, sec), row("Median", a.median, b.median, fmt, sec),
        row("Streuung ±", a.spread, b.spread, sec, sec), row("Ungültig", a.inv, b.inv, (v) => `${v} %`, (v) => `${v} %`)))),
    h("p", { class: `verdict ${verdict[0]}` }, verdict[1]));
}

async function addChange(e) {
  e.preventDefault();
  const c = curCombo(); if (!c) return;
  const f = new FormData(e.target);
  const drv = state.driver && state.driver !== ALL_DRIVERS ? state.driver : (state.me || "");
  try {
    const r = await fetch("/api/setup_changes", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: c.game, track: c.track, layout: c.layout, car: c.car, driver: drv,
        part: f.get("part"), before: f.get("before"), after: f.get("after"), note: f.get("note") }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
    await loadSetupChanges(c);
    renderSetupLog();
  } catch (err) { $("#sl-err").textContent = `Speichern fehlgeschlagen: ${err.message}`; }
}
async function delChange(id) {
  if (!confirm("Diesen Eintrag löschen?")) return;
  await fetch(`/api/setup_changes/${id}`, { method: "DELETE" });
  const c = curCombo(); if (c) { await loadSetupChanges(c); renderSetupLog(); }
}

/* --- Reifen & Bremsen ------------------------------------------------------ */
function targetKey(c) { return `sd-psi-${c.game}-${c.car}`; }
function getTarget(c) {
  try { const t = JSON.parse(localStorage.getItem(targetKey(c))); if (t && t.lo && t.hi) return t; } catch (e) { /* leer */ }
  return { lo: 27.0, hi: 28.0, def: true };
}

async function loadStats(c) {
  const drv = state.driver && state.driver !== ALL_DRIVERS ? { driver: state.driver } : {};
  setupState.stats = await getJSON(`/api/lapstats?${new URLSearchParams({ ...Object.fromEntries(comboParams(c)), ...drv, limit: 300 })}`).catch(() => []);
  setupState.statsKey = comboKey(c) + (drv.driver || "");
}

const avg = (arr) => { const v = arr.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
function aggregate(rows) {
  const out = {};
  for (const k of ["tp", "tc", "ti", "tm", "to", "bt", "bt_max"]) {
    const has = rows.filter((r) => r.stats[k]);
    if (has.length) out[k] = [0, 1, 2, 3].map((i) => avg(has.map((r) => r.stats[k][i])));
  }
  for (const k of ["bb", "abs_pct", "tc_pct", "fuel_used", "lock_pct"]) out[k] = avg(rows.map((r) => r.stats[k]));
  for (const k of ["tc_lvl", "abs_lvl", "compound"]) out[k] = rows.map((r) => r.stats[k]).find((v) => v != null);
  return out;
}

/** ABS/TC je Kurve aus den Verläufen: in wie vielen Runden greift es dort ein? */
function interventionsByCorner(kind) {
  const corners = coachState.data && coachState.data.corners;
  const laps = (analysis.traced || []).filter((l) => !l.outlap && !l.inlap && l.trace && l.trace[kind]).slice(0, 20);
  if (!corners || !laps.length) return [];
  const res = [];
  for (const c of corners) {
    let hit = 0;
    for (const l of laps) {
      const arr = l.trace[kind], n = arr.length;
      const a = Math.floor(c.start * n), b = Math.floor((c.end ?? c.start) * n);
      const idx = b > a ? range(a, b) : [...range(a, n), ...range(0, b)];
      if (idx.some((i) => arr[i] === 1)) hit++;
    }
    if (hit) res.push({ no: c.no, name: c.name, hit, of: laps.length });
  }
  return res.sort((x, y) => y.hit - x.hit);
}
const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

function tyreHints(ag, t) {
  const tips = [];
  if (ag.tp) ag.tp.forEach((p, i) => {
    if (p == null) return;
    if (p < t.lo) tips.push([`${WHEELS[i]}: ${nf(p, 2)} psi heiß, unter dem Fenster`, `kalt etwa +${nf(((t.lo + t.hi) / 2 - p), 1)} psi`, "Druck"]);
    else if (p > t.hi) tips.push([`${WHEELS[i]}: ${nf(p, 2)} psi heiß, über dem Fenster`, `kalt etwa −${nf((p - (t.lo + t.hi) / 2), 1)} psi`, "Druck"]);
  });
  if (ag.ti && ag.to) [0, 1, 2, 3].forEach((i) => {
    const d = ag.ti[i] != null && ag.to[i] != null ? ag.ti[i] - ag.to[i] : null;
    if (d == null) return;
    if (d < 3) tips.push([`${WHEELS[i]}: innen nur ${nf(d, 0)} °C wärmer als außen`, "etwas mehr negativer Sturz (Faustregel: innen 5–10 °C wärmer)", "Sturz"]);
    else if (d > 12) tips.push([`${WHEELS[i]}: innen ${nf(d, 0)} °C wärmer als außen`, "etwas weniger negativer Sturz", "Sturz"]);
  });
  if (ag.tm && ag.ti && ag.to) [0, 1, 2, 3].forEach((i) => {
    const edge = avg([ag.ti[i], ag.to[i]]), m = ag.tm[i];
    if (m == null || edge == null) return;
    if (m - edge > 4) tips.push([`${WHEELS[i]}: Mitte ${nf(m - edge, 0)} °C heißer als die Ränder`, "Hinweis auf zu hohen Druck", "Druck"]);
    else if (edge - m > 4) tips.push([`${WHEELS[i]}: Mitte ${nf(edge - m, 0)} °C kühler als die Ränder`, "Hinweis auf zu niedrigen Druck", "Druck"]);
  });
  const abs = interventionsByCorner("abs").filter((x) => x.hit / x.of >= 0.5).slice(0, 3);
  for (const x of abs) tips.push([`ABS greift in ${x.name || "Kurve " + x.no} in ${x.hit} von ${x.of} Runden`, "später oder sanfter anbremsen; bleibt es: Bremsbalance 0,5 % nach hinten testen", "Bremse"]);
  const tc = interventionsByCorner("tcx").filter((x) => x.hit / x.of >= 0.5).slice(0, 3);
  for (const x of tc) tips.push([`TC greift in ${x.name || "Kurve " + x.no} in ${x.hit} von ${x.of} Runden`, "Gas am Ausgang weicher aufbauen; bleibt es: Differenzial (Power) etwas offener oder TC eine Stufe höher", "Traktion"]);
  return tips;
}

function renderTyres() {
  const box = $("#tyres-body");
  const c = curCombo();
  if (!c) { box.replaceChildren(); return; }
  const rows = (setupState.stats || []).filter((r) => !r.outlap && !r.inlap);
  if (!rows.length) {
    box.replaceChildren(h("p", {}, "Für diese Strecke und dieses Auto gibt es noch keine Reifen- und Bremsdaten. Sie kommen mit Collector 0.9 – einfach fahren, ab der nächsten Runde sind sie da."),
      h("p", { class: "muted-sm" }, "Hinweis: AC EVO, ACC und AMS2 liefern Reifendruck und Temperaturen innen/mitte/außen; iRacing nur teilweise (live gesperrt)."));
    return;
  }
  const last = rows[0].session_uid, sess = rows.filter((r) => r.session_uid === last);
  const ag = aggregate(sess), t = getTarget(c);
  const tyre = (i) => {
    const p = ag.tp && ag.tp[i], ok = p != null && p >= t.lo && p <= t.hi;
    return h("div", { class: "tyre" },
      h("div", { class: "hd" }, h("span", {}, WHEELS[i]), p == null ? "" : h("span", { class: ok ? "ok-ic" : "warn-ic" }, ok ? "✓ im Fenster" : p < t.lo ? "⚠ zu niedrig" : "⚠ zu hoch")),
      h("div", { class: "psi num" }, p == null ? "–" : nf(p, 2), h("small", {}, " psi heiß")),
      h("div", { class: "imo" }, ...["ti", "tm", "to"].map((k, j) => h("div", {}, h("span", {}, ["innen", "mitte", "außen"][j]), ag[k] ? `${nf(ag[k][i], 0)} °C` : "–"))),
      h("div", { class: "muted-sm" }, `Kern ${ag.tc ? nf(ag.tc[i], 0) : "–"} °C · Bremse ⌀ ${ag.bt ? nf(ag.bt[i], 0) : "–"} / max ${ag.bt_max ? nf(ag.bt_max[i], 0) : "–"} °C`));
  };
  const tips = tyreHints(ag, t);
  const target = h("form", { class: "psi-target", onsubmit: (e) => {
    e.preventDefault();
    const f = new FormData(e.target), lo = parseFloat(String(f.get("lo")).replace(",", ".")), hi = parseFloat(String(f.get("hi")).replace(",", "."));
    if (lo > 0 && hi > lo) { localStorage.setItem(targetKey(c), JSON.stringify({ lo, hi })); renderTyres(); }
  } }, "Zielfenster heiß ",
  h("input", { name: "lo", class: "input sm", value: nf(t.lo, 1), inputmode: "decimal", "aria-label": "Untergrenze psi" }), " – ",
  h("input", { name: "hi", class: "input sm", value: nf(t.hi, 1), inputmode: "decimal", "aria-label": "Obergrenze psi" }), " psi ",
  h("button", { class: "ghost sm", type: "submit" }, "Übernehmen"),
  t.def ? h("span", { class: "muted-sm" }, " · Standardwert, für Spiel und Auto prüfen") : null);
  const facts = h("div", { class: "chips-row" },
    ag.bb != null ? h("span", { class: "pill" }, "Bremsbalance ", h("b", {}, `${nf(ag.bb * 100, 1)} % vorne`)) : null,
    ag.abs_lvl != null ? h("span", { class: "pill" }, "ABS-Stufe ", h("b", {}, String(ag.abs_lvl))) : null,
    ag.tc_lvl != null ? h("span", { class: "pill" }, "TC-Stufe ", h("b", {}, String(ag.tc_lvl))) : null,
    ag.abs_pct != null ? h("span", { class: "pill" }, "ABS aktiv ", h("b", {}, `${nf(ag.abs_pct, 1)} %`), " der Runde") : null,
    ag.tc_pct != null ? h("span", { class: "pill" }, "TC aktiv ", h("b", {}, `${nf(ag.tc_pct, 1)} %`)) : null,
    ag.fuel_used != null ? h("span", { class: "pill" }, "Sprit ", h("b", {}, `${nf(ag.fuel_used, 2)} l`), " je Runde") : null,
    ag.compound ? h("span", { class: "pill" }, "Mischung ", h("b", {}, ag.compound)) : null);
  const table = h("details", { class: "table-view" }, h("summary", {}, `Alle ${rows.length} Runden mit Daten`),
    h("div", { class: "table-wrap" }, h("table", { class: "ct num" },
      h("thead", {}, h("tr", {}, ...["Zeit", "Runde", "psi VL/VR/HL/HR", "Bremse max VL/VR", "ABS %", "TC %"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...rows.slice(0, 60).map((r) => h("tr", {}, h("td", {}, fmtDate(r.recorded_at)), h("td", {}, fmt(r.lap_time_ms) + (r.valid === false ? " ✗" : "")),
        h("td", {}, (r.stats.tp || []).map((v) => nf(v, 1)).join(" / ")), h("td", {}, (r.stats.bt_max || []).slice(0, 2).map((v) => nf(v, 0)).join(" / ")),
        h("td", {}, nf(r.stats.abs_pct, 1)), h("td", {}, nf(r.stats.tc_pct, 1))))))));
  box.replaceChildren(
    h("p", { class: "muted-sm" }, `Letzte Session mit Daten: ${fmtDate(sess[0].recorded_at)}, ${sess.length} Runden (ohne Out-/Inlaps).`),
    h("div", { class: "tyres" }, ...[0, 1, 2, 3].map(tyre)), target, facts,
    h("div", { class: "subchart-title", style: "margin-top:14px" }, "Vorschläge"),
    tips.length ? h("ol", { class: "steps" }, ...tips.map(([what, how, tag]) => h("li", {}, h("span", {}, h("b", {}, what), " → ", how), h("span", { class: "pill" }, tag))))
      : h("p", {}, "✓ Nichts Auffälliges: Drücke im Fenster, Temperaturverteilung unauffällig, kaum ABS/TC-Eingriffe."),
    h("p", { class: "muted-sm" }, "Faustregeln als Startpunkt, kein Ersatz fürs Testen. Immer nur eine Änderung, dann im Setup-Logbuch eintragen."),
    table);
}

/* --- Einbindung ------------------------------------------------------------ */
async function onSetupPage(page) {
  if (page !== "coach") return;
  const sub = coachSub(), c = curCombo();
  if (sub === "technik" && typeof renderSteering === "function") renderSteering();
  if (!c) return;
  if (sub === "logbuch") { if (setupState.key !== comboKey(c)) await loadSetupChanges(c); renderSetupLog(); }
  if (sub === "reifen") { const k = comboKey(c) + (state.driver !== ALL_DRIVERS ? state.driver || "" : ""); if (setupState.statsKey !== k) await loadStats(c); renderTyres(); }
}
/** Aufgerufen von app.js, wenn die Kombination (neu) geladen ist. */
function onComboLoaded() {
  setupState.key = null; setupState.statsKey = null;
  if (currentPage() === "coach") onSetupPage("coach");
}
