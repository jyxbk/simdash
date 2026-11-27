// SimDash – Fahrverhalten & Setup: wo das Auto schiebt oder das Heck kommt (Daten: /api/handling).
// Globale Helfer aus app.js (h, $, fmt, fmtDate, getJSON, driverParam, isCounting).
"use strict";

const hdState = { c: null, session: "", data: null };

async function loadHandling(c, session) {
  if (!hdState.c || comboKey(hdState.c) !== comboKey(c)) hdState.session = "";
  if (session !== undefined) hdState.session = session;
  hdState.c = c;
  const q = new URLSearchParams({ game: c.game, track: c.track, layout: c.layout, car: c.car, ...driverParam() });
  if (hdState.session) q.set("session_uid", hdState.session);
  const key = q.toString();
  hdState.key = key;
  let d = null;
  try { d = await getJSON(`/api/handling?${q}`); } catch { /* ohne */ }
  if (hdState.key !== key) return;
  hdState.data = d;
  renderHandling();
}

/** Sessions mit mindestens 3 gültigen Runden – zum Prüfen einer Setup-Änderung. */
function handlingSessions() {
  const laps = (state.detail && state.detail.laps) || [];
  const by = new Map();
  for (const l of laps) {
    if (!l.session_uid || !isCounting(l)) continue;
    const e = by.get(l.session_uid) || { uid: l.session_uid, n: 0, at: l.recorded_at };
    e.n += 1; if (l.recorded_at < e.at) e.at = l.recorded_at;
    by.set(l.session_uid, e);
  }
  return [...by.values()].filter((e) => e.n >= 3).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
}

function renderHandling() {
  const body = $("#handling-body"), d = hdState.data;
  if (!body) return;
  const sel = h("select", { "aria-label": "Welche Runden auswerten" },
    h("option", { value: "" }, "Alle Runden (beste 12)"),
    handlingSessions().map((e) => h("option", { value: e.uid }, `Session ${fmtDate(e.at)} · ${e.n} Runden`)));
  sel.value = hdState.session;
  sel.addEventListener("change", () => loadHandling(hdState.c, sel.value));
  const head = h("div", { class: "hd-pick" }, h("label", {}, "Auswerten: ", sel));
  if (!d || !d.ok) {
    const why = !d ? "Gerade nicht erreichbar."
      : d.reason === "too_few_laps"
        ? "Dafür braucht es mindestens 3 saubere Runden mit Lenkung und Position (Collector ab 0.6, AC EVO, ACC oder Assetto Corsa; iRacing liefert keine Position)."
        : "Aus diesen Runden lässt sich kein Fahrverhalten ablesen.";
    body.replaceChildren(head, h("p", { class: "analysis-empty" }, why));
    return;
  }
  const lbl = (no) => cornerShort(d.corners.find((c) => c.no === no) || { no });
  const secTxt = (ms) => `${(ms / 1000).toFixed(2).replace(".", DEC)} s`;
  const findings = d.findings.length
    ? h("div", { class: "coach-cards" }, d.findings.map((f) => h("article", { class: `coach-card hd-card ${f.kind}` },
        h("div", { class: "cc-head" }, h("b", {}, f.title),
          h("span", { class: `hd-badge ${f.kind}` }, f.kind === "under" ? "Untersteuern" : "Übersteuern")),
        h("div", { class: "muted-sm" }, `in ${f.corners.map(lbl).join(", ")}`,
          f.cost_ms == null ? " · Zeitkosten erst ab 4 Runden messbar"
            : f.cost_ms >= 30 ? h("b", { class: "hd-cost" }, ` · kostet etwa ${secTxt(f.cost_ms)} pro Runde`) : " · kostet messbar keine Zeit"),
        h("ul", { class: "cc-tips hd-hints" }, f.hints.map((t) => h("li", {}, t,
          h("button", { class: "hd-note", type: "button", title: "Als Notiz vormerken", onclick: () => noteHint(f, t) }, "＋ Notiz")))))))
    : h("p", { class: "analysis-empty" }, "Kein auffälliges Schieben oder Gegenlenken. Das Auto ist hier ausgewogen, oder die Unterschiede sind kleiner als die Streuung zwischen den Runden.");

  // Tabelle: jede Kurve × Einlenken/Scheitel/Ausgang
  const cell = (p) => {
    if (!p) return h("td", {}, "–");
    const pct = Math.round(p.steer_extra * 100);
    const txt = p.kind === "over" ? `Heck · ${p.countersteer_laps}×` : p.kind === "under" ? `schiebt +${pct} %` : `${pct > 0 ? "+" : ""}${pct} %`;
    return h("td", { class: `hd-cell ${p.kind || ""}`, title: p.countersteer_laps ? `Gegenlenken in ${p.countersteer_laps} von ${d.laps_used} Runden` : "" }, txt);
  };
  const rows = d.corners.map((c) => h("tr", {},
    h("td", {}, h("b", {}, cornerLabel(c)), renameBtn(hdState.c, c)),
    ...["entry", "mid", "exit"].map((k) => cell(c.phases.find((p) => p.key === k)))));
  const table = h("table", { class: "hd-table" },
    h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Einlenken"), h("th", {}, "Scheitel"), h("th", {}, "Ausgang"))),
    h("tbody", {}, rows));
  const details = d.corners.flatMap((c) => c.text.map((t) => h("li", {}, h("b", {}, cornerLabel(c)), ` · ${t}`)));

  body.replaceChildren(head, findings,
    h("div", { class: "subchart-title" }, "Alle Kurven"),
    h("p", { class: "muted-sm" }, "Prozent = wie viel mehr (oder weniger) du lenkst, als die Linie verlangt. Viel mehr heißt: Die Vorderräder schieben. „Heck“ heißt: Du hast gegengelenkt."),
    table, details.length ? h("ul", { class: "coach-notes" }, details) : null,
    h("p", { class: "muted-sm" }, `Aus ${d.laps_used} Runden. Die Diagnose ist eine Schätzung aus Lenkung und gefahrener Linie. Ändere jeweils nur eine Sache, notiere sie und fahr 5 Runden. Dann wähle oben die neue Session und vergleiche.`));
}

function noteHint(f, hint) {
  const ta = $("#notes-text");
  const d = hdState.data;
  const names = f.corners.map((no) => cornerShort((d && d.corners.find((c) => c.no === no)) || { no }));
  ta.value = `Test: ${hint} (wegen „${f.title}“ in ${names.join(", ")})`;
  ta.focus();
  $("#notes").scrollIntoView({ behavior: "smooth", block: "center" });
}
