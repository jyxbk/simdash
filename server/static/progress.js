// SimDash – Fortschritt, Kurven-Verlauf, Setup-Notizen und Session-Bericht.
// Gemeinsamer globaler Bereich mit app.js/coach.js (h, s, $, fmt, groupSessions, coachState …).
"use strict";

const median = (xs) => { const a = [...xs].sort((p, q) => p - q), m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : null; };
const signS = (ms, d = 3) => `${ms < 0 ? "−" : "+"}${(Math.abs(ms) / 1000).toFixed(d)} s`;
const shortDate = (iso) => new Date(iso).toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit" });

/** Kennzahlen einer Session: beste Runde, Median der sauberen Runden (≤ 107 %), Streuung. */
function sessionStats(ls) {
  const counting = ls.filter(isCounting);
  if (!counting.length) return null;
  const times = counting.map((l) => l.lap_time_ms);
  const best = Math.min(...times);
  const clean = times.filter((t) => t <= best * 1.07);
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const sd = Math.sqrt(clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length);
  return { best, median: median(clean), sd, counting: counting.length, total: ls.length, clean: clean.length,
    at: ls[0].recorded_at, end: ls[ls.length - 1].recorded_at, bestLap: counting.find((l) => l.lap_time_ms === best),
    driveMs: ls.reduce((a, l) => a + l.lap_time_ms, 0) };
}

/* --- Kleines Liniendiagramm (eine oder zwei Serien, oben = besser) ------------- */
function miniChart(box, { series, labels, yFmt, lowerIsBetter = true, refLine, height = 170 }) {
  const W = box.clientWidth || 500, H = height, L = 52, R = 12, T = 12, B = 24;
  const all = series.flatMap((se) => se.values.filter((v) => v != null)).concat(refLine ? [refLine.value] : []);
  if (!all.length) { box.replaceChildren(); return; }
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const padv = (hi - lo) * 0.12; lo -= padv; hi += padv;
  const n = labels.length;
  const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R));
  const y = (v) => (lowerIsBetter ? T + ((v - lo) / (hi - lo)) * (H - T - B) : T + ((hi - v) / (hi - lo)) * (H - T - B));
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "mini" });
  const ticks = niceStep(hi - lo, 3);
  const axis = s("g", { class: "axis" });
  for (let v = Math.ceil(lo / ticks) * ticks; v <= hi; v += ticks) {
    axis.append(s("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }));
    const t = s("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }); t.textContent = yFmt(v); axis.append(t);
  }
  const every = Math.max(1, Math.ceil(n / 6));
  labels.forEach((lb, i) => {
    if (i % every && i !== n - 1) return;
    const t = s("text", { x: x(i), y: H - 6, "text-anchor": "middle" }); t.textContent = lb; axis.append(t);
  });
  svg.append(axis);
  if (refLine) {
    svg.append(s("line", { x1: L, x2: W - R, y1: y(refLine.value), y2: y(refLine.value), class: "refline" }));
    const t = s("text", { x: W - R, y: y(refLine.value) - 4, "text-anchor": "end", class: "reflabel" }); t.textContent = refLine.label; svg.append(t);
  }
  for (const se of series) {
    let d = "", pen = false;
    se.values.forEach((v, i) => {
      if (v == null || (se.skip && se.skip[i])) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
    });
    svg.append(s("path", { d, fill: "none", stroke: se.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    se.values.forEach((v, i) => {
      if (v == null) return;
      const c = s("circle", { cx: x(i), cy: y(v), r: se.r || 3.5, fill: se.dim && se.dim[i] ? "var(--surface-1)" : se.color,
        stroke: se.dim && se.dim[i] ? "var(--text-muted)" : "var(--surface-1)", "stroke-width": 1.5 });
      if (se.title) { const tt = s("title"); tt.textContent = se.title(i); c.append(tt); }
      svg.append(c);
    });
  }
  box.replaceChildren(svg);
}

/* --- Fortschritt je Session (Analyse-Tab) -------------------------------------- */
function renderProgress() {
  const box = $("#progress-body");
  if (!box || !state.detail) return;
  const ses = groupSessions(state.detail.laps).reverse()
    .map((ls) => ({ ls, st: sessionStats(ls) })).filter((x) => x.st).slice(-14);
  if (ses.length < 2) {
    box.replaceChildren(h("p", { class: "analysis-empty" }, ses.length ? "Ab der zweiten Session siehst du hier, wie du dich entwickelst." : "Noch keine gültigen Runden."));
    return;
  }
  const last = ses[ses.length - 1].st, prev = ses[ses.length - 2].st;
  const first = ses[0].st;
  const dBest = last.best - prev.best, dMed = last.median - prev.median;
  const line = (label, d) => h("span", { class: d < 0 ? "delta-good" : d > 0 ? "delta-bad" : "" }, `${label} ${signS(d, d && Math.abs(d) < 1000 ? 3 : 2)}`);
  const head = h("div", { class: "prog-head" },
    h("div", {}, h("b", {}, `Letzte Session (${shortDate(last.at)})`), `: Bestzeit ${fmt(last.best)}, Median ${fmt(Math.round(last.median))}`),
    h("div", { class: "prog-deltas" }, "zur Session davor: ", line("Bestzeit", dBest), " · ", line("Median", dMed),
      ses.length > 2 ? [" · seit ", shortDate(first.at), ": ", line("Median", last.median - first.median)] : ""));
  const chartBox = h("div", { class: "mini-box", role: "img", "aria-label": "Bestzeit und Median je Session" });
  const key = (color, label) => h("span", { class: "key" }, h("span", { class: "swatch", style: `background:${color}` }), label);
  box.replaceChildren(head, h("div", { class: "legend" }, key("var(--series-1)", "Bestzeit der Session"), key("var(--series-2)", "Median (saubere Runden)"), h("span", { class: "key muted" }, "oben = schneller")), chartBox);
  miniChart(chartBox, {
    labels: ses.map((x, i) => (ses.some((y, j) => j !== i && shortDate(y.st.at) === shortDate(x.st.at))
      ? `${shortDate(x.st.at)} ${new Date(x.st.at).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })}` : shortDate(x.st.at))),
    yFmt: (v) => fmt(Math.round(v)).replace(/\.\d+$/, (m) => m.slice(0, 2)),
    series: [
      { values: ses.map((x) => x.st.median), color: "var(--series-2)", title: (i) => `${shortDate(ses[i].st.at)} · Median ${fmt(Math.round(ses[i].st.median))} · ${ses[i].st.clean} saubere Runden` },
      { values: ses.map((x) => x.st.best), color: "var(--series-1)", title: (i) => `${shortDate(ses[i].st.at)} · Bestzeit ${fmt(ses[i].st.best)} · ${ses[i].st.counting} gültige Runden` },
    ],
  });
}

/* --- Kurven-Verlauf: wirkt der Tipp? ------------------------------------------- */
function renderCornerHistory() {
  const box = $("#corner-history");
  const d = coachState.data;
  if (!box || !d || !d.corners || !d.corners.length) { if (box) box.replaceChildren(); return; }
  const ranked = d.corners.filter((c) => c.gain_ms >= MIN_GAIN).sort((a, b) => b.gain_ms - a.gain_ms);
  const c = d.corners.find((x) => x.no === coachState.focus) || ranked[0] || d.corners[0];
  const hist = (c.history || []).slice(-40);
  if (hist.length < 2) { box.replaceChildren(); return; }
  const best = Math.min(...hist.filter((x) => x.clean).map((x) => x.ms));
  const recent = hist.filter((x) => x.clean).slice(-5), older = hist.filter((x) => x.clean).slice(0, -5);
  const avg = (xs, k) => xs.length ? xs.reduce((a, x) => a + x[k], 0) / xs.length : null;
  const msgs = [];
  if (recent.length >= 3) {
    msgs.push(`Letzte ${recent.length} saubere Runden im Schnitt ${signS(avg(recent, "ms") - best, 2)} hinter deiner besten Fahrt hier`);
    if (older.length >= 3) {
      const dd = avg(recent, "ms") - avg(older, "ms");
      if (Math.abs(dd) >= 20) msgs.push(dd < 0 ? `wirst schneller (${signS(dd, 2)} gegenüber den Runden davor)` : `zuletzt langsamer (${signS(dd, 2)})`);
    }
  }
  const br = hist.filter((x) => x.brake_m != null);
  if (br.length >= 3 && c.best_metrics.brake_m != null) {
    const rb = avg(br.slice(-5), "brake_m");
    msgs.push(`Bremspunkt zuletzt ⌀ ${Math.round(rb)} m vorm Scheitel, beste Fahrt ${c.best_metrics.brake_m} m`);
  }
  const tBox = h("div", { class: "mini-box", role: "img", "aria-label": `Zeit in ${cornerLabel(c)} je Runde` });
  const bBox = br.length >= 3 ? h("div", { class: "mini-box", role: "img", "aria-label": `Bremspunkt in ${cornerLabel(c)} je Runde` }) : null;
  const pick = h("div", { class: "chips ch-pick" }, d.corners.map((x) => h("button", { type: "button", class: "chip", "aria-pressed": String(x.no === c.no), onclick: () => { focusCorner(x.no, true); } }, cornerShort(x))));
  box.replaceChildren(
    h("div", { class: "ch-head" }, h("div", { class: "subchart-title" }, `Verlauf ${cornerLabel(c)}: wirkt der Tipp?`), pick),
    msgs.length ? h("div", { class: "muted-sm ch-msg" }, msgs.join(" · ")) : null,
    h("div", { class: "ch-charts" },
      h("div", {}, h("div", { class: "mini-title" }, "Zeit in der Kurve (oben = schneller)"), tBox),
      bBox ? h("div", {}, h("div", { class: "mini-title" }, "Bremspunkt, m vorm Scheitel (oben = später)"), bBox) : null));
  const labels = hist.map((x) => `${LAP_SHORT}${x.lap_number ?? "?"}`);
  const title = (i) => `${LAP_SHORT}${hist[i].lap_number ?? "?"} · ${shortDate(hist[i].recorded_at)} · ${(hist[i].ms / 1000).toFixed(3)} s · Scheitel ${hist[i].v_min != null ? Math.round(hist[i].v_min) : "–"} km/h${hist[i].brake_m != null ? ` · Bremse ${hist[i].brake_m} m` : ""}${hist[i].clean ? "" : " · nicht sauber"}`;
  miniChart(tBox, { labels, yFmt: (v) => (v / 1000).toFixed(1), height: 150, refLine: { value: best, label: "beste Fahrt" },
    series: [{ values: hist.map((x) => x.ms), color: "var(--series-1)", dim: hist.map((x) => !x.clean), skip: hist.map((x) => !x.clean), title }] });
  if (bBox) miniChart(bBox, { labels, yFmt: (v) => Math.round(v), height: 150, refLine: c.best_metrics.brake_m != null ? { value: c.best_metrics.brake_m, label: "beste Fahrt" } : null,
    series: [{ values: hist.map((x) => x.brake_m), color: "var(--series-2)", dim: hist.map((x) => !x.clean), title }] });
}

/* --- Setup-Notizen ------------------------------------------------------------- */
const notesState = { c: null, list: [] };
async function loadNotes(c) {
  notesState.c = c;
  try { notesState.list = await getJSON(`/api/notes?${new URLSearchParams({ game: c.game, track: c.track, layout: c.layout, car: c.car })}`); }
  catch { notesState.list = []; }
  if (notesState.c === c) renderNotes();
}
function renderNotes() {
  const box = $("#notes-list");
  if (!box) return;
  box.replaceChildren(...(notesState.list.length ? notesState.list.map((n) => h("li", {},
    h("div", { class: "note-text" }, n.text),
    h("div", { class: "note-meta" }, `${fmtDate(n.created)}${n.driver && n.driver !== state.me ? ` · ${n.driver}` : ""}`,
      h("button", { class: "note-del", type: "button", title: "Notiz löschen", "aria-label": "Notiz löschen",
        onclick: async () => { if (!confirm("Notiz löschen?")) return; await fetch(`/api/notes/${n.id}`, { method: "DELETE" }); loadNotes(notesState.c); } }, "✕"))))
    : [h("li", { class: "muted-sm" }, "Noch keine Notizen. Schreib auf, was am Setup oder an der Linie geholfen hat.")]));
}
$("#notes-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const c = notesState.c, ta = $("#notes-text"), text = ta.value.trim();
  if (!c || !text) return;
  const r = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ game: c.game, track: c.track, layout: c.layout, car: c.car, text, driver: state.driver && state.driver !== ALL_DRIVERS ? state.driver : "" }) });
  if (r.ok) { ta.value = ""; loadNotes(c); } else alert("Speichern fehlgeschlagen");
});

/* --- Session-Bericht (Übersicht) ----------------------------------------------- */
const reportState = { key: null, coach: new Map() };
function renderReport() {
  const box = $("#report");
  const sessions = groupSessions(state.laps || []);
  if (!sessions.length) { box.hidden = true; return; }
  const skey = (ls) => ls[0].session_uid || comboKey(ls[0]) + ls[0].recorded_at;
  const ls = sessions.find((x) => skey(x) === reportState.key) || sessions[0];
  const first = ls[0], st = sessionStats(ls);
  box.hidden = false;
  const combo = state.bests.find((b) => comboKey(b) === comboKey(first));
  const pb = combo && combo.best_valid;
  const prevLs = sessions.filter((x) => comboKey(x[0]) === comboKey(first) && x[x.length - 1].recorded_at < first.recorded_at)[0];
  const prev = prevLs && sessionStats(prevLs);
  const isNewest = ls === sessions[0];
  const item = (label, value, sub, cls) => h("div", { class: `insight${cls ? " " + cls : ""}` }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), h("div", { class: "sub" }, sub || ""));

  const kids = [h("div", { class: "rep-head" },
    h("div", {}, h("div", { class: "label" }, isNewest ? "Bericht zur letzten Session" : "Session-Bericht"),
      h("div", { class: "what" }, trackName(first), " ", h("span", { class: "car" }, `· ${pretty(first.car)} · ${gameName(first.game)}`)),
      h("div", { class: "muted-sm" }, `${fmtDate(first.recorded_at)} · ${SESSION_NAMES[first.session_type] || first.session_type || "Session"} · ${fmtDuration(st ? st.driveMs : 0)} gefahren`)),
    h("div", { class: "rep-actions" },
      !isNewest ? h("button", { class: "ghost", type: "button", onclick: () => { reportState.key = null; renderReport(); } }, "Neueste") : null,
      combo ? h("button", { class: "ghost", type: "button", onclick: () => openDetail(combo) }, "Im Coach öffnen") : null))];

  if (!st) {
    kids.push(h("p", { class: "analysis-empty" }, `${ls.length} ${ls.length === 1 ? "Runde" : "Runden"}, aber keine gültige. Kein Bericht möglich.`));
    box.replaceChildren(...kids);
    return;
  }
  const newPb = pb && st.bestLap && pb.id === st.bestLap.id;
  kids.push(h("div", { class: "insights" },
    item("Beste Runde", fmt(st.best), newPb ? "★ neue Bestzeit!" : pb ? `${signS(st.best - pb.lap_time_ms)} zur PB` : "", newPb ? "pb" : ""),
    item("Runden", `${st.counting} / ${st.total}`, `gültig · ${st.clean} sauber (≤ 107 %)`),
    item("Konstanz", `±${(st.sd / 1000).toFixed(2)} s`, `Median ${fmt(Math.round(st.median))}`),
    item("Zur Session davor", prev ? signS(st.median - prev.median, 2) : "–", prev ? `Median · Bestzeit ${signS(st.best - prev.best)}` : "erste Session mit dieser Kombi"),
  ));
  const coachBox = h("div", { class: "rep-coach" });
  kids.push(coachBox);
  box.replaceChildren(...kids);
  fillReportCoach(coachBox, ls, combo);
}

async function fillReportCoach(box, ls, combo) {
  const first = ls[0];
  if (!first.session_uid || !combo) return;
  const ck = `${first.session_uid}|${ls.length}|${state.driver}`;
  let d = reportState.coach.get(ck);
  if (!d) {
    try {
      d = await getJSON(`/api/coach?${new URLSearchParams({ game: first.game, track: first.track, layout: first.layout, car: first.car, session_uid: first.session_uid, ...driverParam() })}`);
      reportState.coach.set(ck, d);
    } catch { return; }
  }
  const notes = await getJSON(`/api/notes?${new URLSearchParams({ game: first.game, track: first.track, layout: first.layout, car: first.car })}`).catch(() => []);
  const lines = [];
  const top = (d.corners || []).filter((c) => c.gain_ms >= MIN_GAIN).sort((a, b) => b.gain_ms - a.gain_ms)[0];
  if (d.ideal_ms && d.potential_ms != null) lines.push(h("li", {}, `Ideale Runde dieser Session `, h("b", {}, fmt(d.ideal_ms)), ` (${secs(d.potential_ms, 2)} unter deiner besten Runde heute).`));
  if (top) lines.push(h("li", {}, `Größte Baustelle: `, h("b", {}, cornerLabel(top)), ` (−${secs(top.gain_ms, 2)}). ${top.tips[0] ? top.tips[0].text + "." : ""}`));
  const shaky = (d.corners || []).find((c) => c.no === d.least_consistent);
  if (shaky && shaky.spread_ms >= 80) lines.push(h("li", {}, `Am unruhigsten: ${cornerLabel(shaky)} (±${secs(shaky.spread_ms, 2)}).`));
  if (notes.length) lines.push(h("li", { class: "rep-note" }, `Letzte Notiz (${shortDate(notes[0].created)}): „${notes[0].text}“`));
  box.replaceChildren(lines.length ? h("ul", { class: "coach-notes" }, lines) : "");
}

function showSessionReport(ls) {
  reportState.key = ls[0].session_uid || comboKey(ls[0]) + ls[0].recorded_at;
  renderReport();
  $("#report").scrollIntoView({ behavior: "smooth", block: "start" });
}
