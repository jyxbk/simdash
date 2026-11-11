"use strict";
// ---------------------------------------------------------------------------
// Safety Rating (Seite #safety, Fahrerkarte in der Seitenleiste, Kachel auf der Übersicht).
// Daten: GET /api/safety (Server rechnet, siehe server/safety.py). Nutzt h/s/$/pretty/fmt aus app.js.
// ---------------------------------------------------------------------------
const srState = { data: null, at: 0 };
const KIND_DE = { invalid: "ungültige Runde", off: "Abflug / Kontrollverlust", crash: "Einschlag", iracing: "iRacing-Incident" };
const de2 = (n, d = 2) => Number(n).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const initials = (n) => (n || "?").split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase();

/** Fahrer, dessen Rating gezeigt wird: der gefilterte, sonst „ich“. */
function srDriver() {
  const d = state.driver && state.driver !== ALL_DRIVERS ? state.driver : state.me;
  const all = srState.data ? Object.keys(srState.data.drivers) : [];
  return all.includes(d) ? d : all[0];
}

async function loadSafety(force = false) {
  if (!force && srState.data && Date.now() - srState.at < 30000) return renderSafetyAll();
  try {
    srState.data = await getJSON("/api/safety");
    srState.at = Date.now();
  } catch (e) { console.error(e); }
  renderSafetyAll();
}

function renderSafetyAll() {
  renderDriverCard();
  renderSrMini();
  if (currentPage() === "safety") renderSafety();
}

function renderDriverCard() {
  const el = $("#driver-card");
  const name = srDriver();
  const d = name && srState.data.drivers[name];
  el.replaceChildren(
    h("span", { class: "avatar" }, initials(name || state.me)),
    h("span", { class: "meta" }, h("div", {}, name || state.me || "Fahrer"),
      h("div", {}, d ? `Safety Rating ${d.klass} ${de2(d.sr)}` : "Safety Rating –")));
}

function renderSrMini() {
  const el = $("#sr-mini");
  const name = srDriver();
  const d = name && srState.data && srState.data.drivers[name];
  el.hidden = !d;
  if (!d) return;
  el.replaceChildren(h("a", { class: "sr-mini-card", href: "#safety" },
    licenseBadge(d, true),
    h("div", { class: "sr-mini-t" },
      h("b", {}, `Safety Rating · ${name}`),
      h("span", {}, d.to_promotion != null ? `noch ${de2(d.to_promotion)} bis Klasse ${nextClass(d.klass)}` : "höchste Klasse erreicht",
        d.recent.cpi ? ` · ${de2(d.recent.cpi, 1)} Kurven je Zwischenfall-Punkt` : "")),
    h("span", { class: "sr-mini-go" }, "Details →")));
}

const nextClass = (k) => { const c = srState.data.rules.classes; return c[Math.min(c.length - 1, c.indexOf(k) + 1)]; };

function licenseBadge(d, small = false) {
  return h("div", { class: `license${small ? " small" : ""}`, "aria-label": `Klasse ${d.klass}, Rating ${de2(d.sr)}` },
    h("div", { class: "cls" }, d.klass), h("div", { class: "no num" }, de2(d.sr)));
}

function srStatus(d) {
  if (d.sr >= 3) return h("span", { class: "status-line good" }, "✓ Sauber unterwegs");
  if (d.sr >= 2) return h("span", { class: "status-line warn" }, "⚠ Ausbaufähig");
  return h("span", { class: "status-line crit" }, "⚠ Viele Zwischenfälle – Abstieg droht unter 1,00");
}

function srTile(label, value, sub) {
  return h("div", { class: "tile" }, h("div", { class: "label" }, label), h("div", { class: "value num" }, value), sub ? h("div", { class: "sub" }, sub) : null);
}

function renderSafety() {
  const box = $("#safety-body");
  const data = srState.data;
  if (!data || !Object.keys(data.drivers).length) {
    box.replaceChildren(h("div", { class: "detail-card" }, h("p", {}, data ? "Noch keine gewerteten Runden." : "Lädt …")));
    return;
  }
  const name = srDriver(), d = data.drivers[name], r = data.rules;
  $("#sr-sub").textContent = `Wie sauber fährt ${name}? Nach dem Vorbild von iRacing: Zwischenfälle pro Kurve, Lizenzklassen R bis A.`;
  const inClass = d.sessions_in_class, need = r.min_sessions;
  const kinds = Object.entries(d.recent.kinds || {}).map(([k, n]) => `${n}× ${KIND_DE[k] || k}`).join(", ") || "keine";
  const pct = (v) => `${(v / 4.99) * 100}%`;

  const hero = h("section", { class: "detail-card sr-hero" },
    licenseBadge(d),
    h("div", { class: "sr-text" },
      h("h2", {}, `Klasse ${d.klass} · ${de2(d.sr)}`),
      h("p", {}, d.to_promotion == null ? "Höchste Klasse erreicht. Halte das Rating über 1,00." :
        d.sr >= r.promote_at ? `Rating reicht für Klasse ${nextClass(d.klass)}; noch ${Math.max(0, need - inClass)} Session(s) in dieser Klasse nötig.` :
          `Noch ${de2(d.to_promotion)} bis zum Aufstieg in Klasse ${nextClass(d.klass)} (ab ${de2(r.promote_at)} und mindestens ${need} Sessions in der Klasse, aktuell ${inClass}).`,
        d.last_change != null ? ` Letzte Session: ${d.last_change >= 0 ? "+" : "−"}${de2(Math.abs(d.last_change))}.` : ""),
      h("div", { class: "meter", "aria-hidden": "true" },
        h("div", { class: "meter-bar" }, h("div", { class: `meter-fill ${d.sr >= 3 ? "ok" : d.sr >= 2 ? "warn" : "crit"}`, style: `width:${pct(d.sr)}` }),
          h("i", { class: "meter-mark", style: `left:${pct(r.demote_below)}` }), h("i", { class: "meter-mark", style: `left:${pct(r.promote_at)}` })),
        h("div", { class: "meter-ticks" },
          h("span", { style: "left:0%" }, "0"), h("span", { style: `left:${pct(r.demote_below)}` }, `${de2(r.demote_below)} Abstieg`),
          h("span", { style: `left:${pct(r.promote_at)}` }, `${de2(r.promote_at)} Aufstieg`))),
      srStatus(d)));

  const tiles = h("section", { class: "tiles sr-tiles" },
    srTile("Kurven je Zwischenfall-Punkt", d.recent.cpi ? de2(d.recent.cpi, 1) : "∞", `letzte ${d.recent.sessions} Sessions · höher ist besser`),
    srTile("Zwischenfall-Punkte", String(d.recent.points), kinds),
    srTile("Gefahrene Kurven", d.recent.corners.toLocaleString("de-DE"), `in ${d.recent.sessions} Sessions`),
    srTile("Sessions gewertet", String(d.sessions), `davon ${inClass} in Klasse ${d.klass}`));

  const trend = h("section", { class: "detail-card" }, h("div", { class: "detail-title" }, "Verlauf je Session"),
    h("div", { class: "muted-sm" }, "Rating nach jeder Session · Punkte antippen für Details · Buchstabe = Klassenwechsel"),
    h("div", { class: "sr-chart", id: "sr-chart" }));

  const maxCpi = 80;
  const tracks = h("section", { class: "detail-card" }, h("div", { class: "detail-title" }, "Wo es hakt"),
    h("div", { class: "muted-sm" }, "Kurven je Zwischenfall-Punkt je Strecke (letzte 10 Sessions) · kurzer Balken = viele Zwischenfälle"),
    ...d.tracks.map((t) => h("div", { class: "hbar" },
      h("div", { class: "hb-id" }, trackThumb(t, 34), h("div", {}, pretty(t.track), h("div", { class: "muted-sm" }, `${t.laps} Runden · ${t.points} Punkte`))),
      h("div", { class: "bar" }, h("i", { style: `width:${t.cpi == null ? 100 : Math.max(2, Math.min(100, t.cpi / maxCpi * 100))}%` })),
      h("div", { class: "val num" }, t.cpi == null ? "sauber" : de2(t.cpi, 1)))),
    d.hot_corners.length ? h("div", { class: "hot" }, h("div", { class: "subchart-title" }, "Häufigste Stellen"),
      h("ul", {}, ...d.hot_corners.map((c) => h("li", {}, `${pretty(c.track)} · Kurve ${c.corner}: `, h("b", {}, `${c.points} Punkte`))))) :
      h("p", { class: "muted-sm" }, "Wo genau Runden ungültig werden, zeigt SimDash ab Collector 0.9.1 – erst neue Runden haben diese Angabe."));

  const recent = d.history.slice(-10).reverse();
  const table = h("section", { class: "detail-card" }, h("div", { class: "detail-title" }, "Letzte Sessions"),
    h("div", { class: "table-wrap" }, h("table", { class: "sr-table num" },
      h("thead", {}, h("tr", {}, ...["Datum", "Strecke", "Runden", "Punkte", "Kurven/Punkt", "Rating"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...recent.map((x) => h("tr", {},
        h("td", {}, fmtDate(x.at)), h("td", {}, pretty(x.track)), h("td", {}, String(x.laps)), h("td", {}, String(x.points)),
        h("td", {}, x.cpi == null ? "sauber" : de2(x.cpi, 1)),
        h("td", {}, `${de2(x.sr_before)} → `, h("b", {}, `${x.klass} ${de2(x.sr)}`),
          x.event ? h("span", { class: `ev ${x.event}` }, x.event === "promotion" ? " ▲ Aufstieg" : " ▼ Abstieg") : null)))))));

  const drivers = Object.entries(data.drivers);
  const cmp = drivers.length > 1 ? h("section", { class: "detail-card" }, h("div", { class: "detail-title" }, "Fahrer im Vergleich"),
    h("div", { class: "table-wrap" }, h("table", { class: "sr-table num" },
      h("thead", {}, h("tr", {}, ...["Fahrer", "Klasse", "Rating", "Kurven/Punkt", "Sessions"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...drivers.map(([n, x]) => h("tr", { class: n === name ? "sel" : "" },
        h("td", {}, n), h("td", {}, h("b", {}, x.klass)), h("td", {}, de2(x.sr)),
        h("td", {}, x.recent.cpi ? de2(x.recent.cpi, 1) : "∞"), h("td", {}, String(x.sessions)))))))) : null;

  const rules = h("details", { class: "detail-card explain" }, h("summary", {}, "So wird das Safety Rating berechnet"),
    h("ul", {},
      h("li", {}, "Zwischenfall-Punkte je Runde: ungültige Runde (Track Limits) 1, Abflug oder Kontrollverlust 2 (über 45 km/h Tempoverlust ohne Bremse), Einschlag 4 (über 80 km/h auf wenigen Metern). iRacing-Runden zählen mit den Punkten aus dem Spiel."),
      h("li", {}, "Daraus wird je Session berechnet, wie viele Kurven du pro Punkt fährst. Höhere Klassen verlangen dafür mehr: in R reichen 60 Kurven je Punkt für 4,99, in A braucht es 250."),
      h("li", {}, "Das Rating bewegt sich pro Session nur ein Stück in Richtung dieses Werts – lange Sessions zählen mehr, höchstens die Hälfte des Abstands."),
      h("li", {}, `Start in Klasse R mit ${de2(r.start)}. Aufstieg ab ${de2(r.promote_at)} nach mindestens ${r.min_sessions} Sessions in der Klasse (Rating sinkt dabei um 1,00). Abstieg unter ${de2(r.demote_below)} (neu ${de2(r.start)}).`),
      h("li", {}, "Out- und Inlaps zählen nicht. Angelehnt an iRacing, aber eigene Formeln.")));

  box.replaceChildren(hero, tiles, trend, h("div", { class: "an-row" }, tracks, table), cmp || "", rules);
  drawSrChart($("#sr-chart"), d.history);
}

function drawSrChart(box, hist) {
  box.replaceChildren();
  if (!hist.length) return;
  const W = Math.max(300, box.clientWidth || 640), H = 220, P = { l: 34, r: 14, t: 18, b: 26 };
  const n = hist.length, x = (i) => P.l + (n < 2 ? (W - P.l - P.r) / 2 : i * (W - P.l - P.r) / (n - 1));
  const y = (v) => P.t + (1 - v / 5) * (H - P.t - P.b);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Safety Rating je Session" });
  for (const v of [0, 1, 2, 3, 4, 5]) {
    svg.append(s("line", { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), stroke: "var(--grid)" }));
    const t = s("text", { x: P.l - 8, y: y(v) + 4, "text-anchor": "end", class: "axis-t" }); t.textContent = v; svg.append(t);
  }
  for (const [v, cls] of [[1, "var(--critical)"], [4, "var(--good)"]]) svg.append(s("line", { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), stroke: cls, "stroke-dasharray": "4 4", opacity: ".6" }));
  // Linie je Klasse (bei Klassenwechsel springt das Rating -> neue Linie)
  let seg = [];
  const flush = () => { if (seg.length > 1) svg.append(s("path", { d: seg.map((p, k) => `${k ? "L" : "M"}${p[0]},${p[1]}`).join(""), fill: "none", stroke: "var(--series-1)", "stroke-width": 2, "stroke-linejoin": "round" })); };
  hist.forEach((h0, i) => {
    if (h0.event) { flush(); seg = []; const t = s("text", { x: x(i), y: P.t - 4, "text-anchor": "middle", class: "axis-t ev-t" }); t.textContent = h0.klass; svg.append(t); }
    seg.push([x(i).toFixed(1), y(h0.sr).toFixed(1)]);
  });
  flush();
  hist.forEach((h0, i) => {
    const c = s("circle", { cx: x(i), cy: y(h0.sr), r: 4, fill: "var(--series-1)", stroke: "var(--surface-1)", "stroke-width": 2 });
    const hit = s("circle", { cx: x(i), cy: y(h0.sr), r: 12, fill: "transparent", style: "cursor:pointer" });
    const show = (ev) => showTip(ev, `${fmtDate(h0.at)} · ${pretty(h0.track)}\n${h0.laps} Runden · ${h0.points} Punkte · ${h0.cpi == null ? "sauber" : de2(h0.cpi, 1) + " Kurven/Punkt"}\n${de2(h0.sr_before)} → ${h0.klass} ${de2(h0.sr)}`);
    hit.addEventListener("mousemove", show); hit.addEventListener("click", show); hit.addEventListener("mouseleave", hideTip);
    svg.append(c, hit);
  });
  box.append(svg);
}

function showTip(ev, text) {
  const tip = $("#tooltip");
  tip.replaceChildren(...text.split("\n").flatMap((ln, i) => (i ? [h("br"), ln] : [ln])));
  tip.hidden = false;
  const x = (ev.touches ? ev.touches[0].clientX : ev.clientX), y = (ev.touches ? ev.touches[0].clientY : ev.clientY);
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, x + 12)}px`;
  tip.style.top = `${y + 12}px`;
}
function hideTip() { $("#tooltip").hidden = true; }

/* --- Collector-Seite ------------------------------------------------------- */
function renderCollectorPage() {
  const games = [["AC EVO", "voll (Reifen, Bremsen, Linie, Coach)"], ["Assetto Corsa Competizione", "voll"], ["iRacing", "Runden, Incidents, Pedale (keine Streckenkarte)"],
    ["Le Mans Ultimate", "voll (Reifen, Bremsen, Linie, Coach) – ab Collector 0.10"], ["Automobilista 2", "voll (in AMS2: Optionen → System → Shared Memory = „Project CARS 2“)"], ["Assetto Corsa", "Runden ohne Gültigkeit"], ["AC Rally", "experimentell"]];
  $("#collector-body").replaceChildren(
    h("section", { class: "detail-card" }, h("div", { class: "detail-title" }, "Herunterladen"),
      h("p", {}, "Windows-Paket mit Start-, Test- und Autostart-Skript. Braucht Python 3."),
      h("a", { class: "btn primary", href: "/static/simdash-collector.zip" }, "Collector für Windows herunterladen")),
    h("section", { class: "detail-card" }, h("div", { class: "detail-title" }, "Unterstützte Spiele"),
      h("table", { class: "sr-table" }, h("tbody", {}, ...games.map(([g, t]) => h("tr", {}, h("td", {}, h("b", {}, g)), h("td", {}, t)))))),
    h("section", { class: "detail-card" }, h("div", { class: "detail-title" }, "Was pro Runde gespeichert wird"),
      h("ul", {}, h("li", {}, "Rundenzeit, Sektoren, gültig/ungültig und wo die Runde ungültig wurde"),
        h("li", {}, "Verlauf: Tempo, Gas, Bremse, Gang, Lenkung, Quer-g, Gierrate, Position, ABS/TC-Eingriffe"),
        h("li", {}, "Ab Version 0.9: Reifendruck und -temperaturen (innen/mitte/außen), Bremstemperaturen, Bremsbalance, TC/ABS-Stufen, Spritverbrauch"))));
}

/* --- Hooks ----------------------------------------------------------------- */
function onPageShown(page) {
  if (page === "safety") { renderSafety(); loadSafety(); }
  if (page === "collector") renderCollectorPage();
  if (typeof onSetupPage === "function") onSetupPage(page);
}
$("#f-driver").addEventListener("change", () => setTimeout(renderSafetyAll, 0));
window.addEventListener("resize", () => { if (currentPage() === "safety" && srState.data) drawSrChart($("#sr-chart"), srState.data.drivers[srDriver()].history); });
loadSafety();
setInterval(() => { if (!document.hidden) loadSafety(true); }, 60000);
