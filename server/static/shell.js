"use strict";
// ---------------------------------------------------------------------------
// SimDash – Gerüst: Seitenleiste, Seiten (Hash-Routing), Sichtbarkeit der Bereiche.
// Wird vor app.js geladen; live.js nutzt currentPage()/currentTab() für die Umschaltung.
// ---------------------------------------------------------------------------

const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>',
  live: '<circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>',
  cockpit: '<circle cx="12" cy="13" r="8"/><path d="m12 13 4-4"/><path d="M8 18h8"/>',
  sessions: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  coach: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  compare: '<path d="M4 18c3-8 5-12 8-12s5 4 8 12"/><path d="M4 18c3-5 6-7 8-7s5 2 8 7" opacity=".6"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  progress: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  collector: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
};

const NAV = [
  { label: "Fahren", items: [
    { id: "overview", t: "Übersicht", i: "home", sub: "Dein Stand über alle Spiele" },
    { id: "live", t: "Live", i: "live", dot: true },
    { id: "cockpit", t: "Cockpit", i: "cockpit" }] },
  { label: "Auswerten", items: [
    { id: "sessions", t: "Sessions", i: "sessions", sub: "Alle Fahrten, neueste zuerst" },
    { id: "bests", t: "Bestzeiten", i: "trophy", sub: "Bestzeit je Strecke und Auto" },
    { id: "coach", t: "Coach & Setup", i: "coach", sub: "Wo du Zeit verlierst, woran es liegt und was du tun kannst" },
    { id: "compare", t: "Rundenvergleich", i: "compare", sub: "Zwei Runden übereinander: Delta, Tempo, Pedale, Linie" }] },
  { label: "Fahrer", items: [
    { id: "safety", t: "Safety Rating", i: "shield" },
    { id: "progress", t: "Fortschritt", i: "progress", sub: "Bestzeit und Median je Session" }] },
  { label: "System", items: [
    { id: "collector", t: "Collector & Spiele", i: "collector" }] },
];
const NAV_ITEMS = NAV.flatMap((g) => g.items.map((x) => ({ ...x, group: g.label })));
const ANALYSE_PAGES = ["coach", "compare", "progress"];
const COACH_SUBS = ["zeit", "technik", "setup", "logbuch", "reifen"];

/** Seite aus der Adresse: #coach/setup → coach (Unterseite setup); alte Links #analyse → coach. */
function currentPage() {
  const h = location.hash.replace(/^#/, "").split("/")[0];
  if (!h) return "overview";
  if (h === "analyse") return "coach";
  return NAV_ITEMS.some((x) => x.id === h) ? h : "overview";
}
function coachSub() {
  let s = location.hash.replace(/^#/, "").split("/")[1];
  if (s === "lenkung") s = "technik";                       // alter Link
  return COACH_SUBS.includes(s) ? s : "zeit";
}
/** Grobe Gruppe für den bestehenden Code (Live-Stream, Analyse-Daten laden, Neuladen). */
function currentTab() {
  const p = currentPage();
  if (p === "live" || p === "cockpit") return "live";
  if (ANALYSE_PAGES.includes(p)) return "analyse";
  return p === "overview" || p === "sessions" || p === "bests" ? "overview" : p;
}

const navIcon = (k) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;

function renderNav() {
  const page = currentPage();
  const nav = document.getElementById("nav");
  nav.innerHTML = "";
  for (const g of NAV) {
    const grp = document.createElement("div");
    grp.className = "nav-group";
    grp.innerHTML = `<div class="nav-label">${g.label}</div>`;
    for (const it of g.items) {
      const a = document.createElement("a");
      a.className = "nav-item";
      a.href = it.id === "overview" ? "#" : `#${it.id}`;
      a.dataset.label = it.t;
      if (it.id === page) a.setAttribute("aria-current", "page");
      a.innerHTML = `${navIcon(it.i)}<span class="nav-t"></span>${it.dot ? '<i class="live-dot" id="tab-live-dot" hidden title="Live-Daten kommen an"></i>' : ""}`;
      a.querySelector(".nav-t").textContent = it.t;
      grp.appendChild(a);
    }
    nav.appendChild(grp);
  }
}

/** Bereiche mit data-pages nur auf ihren Seiten zeigen (unabhängig von `hidden` des Fachcodes). */
function applyPageVisibility() {
  const page = currentPage();
  const keys = new Set([page, page === "coach" ? `coach:${coachSub()}` : null]);
  for (const el of document.querySelectorAll("[data-pages]")) {
    const on = el.dataset.pages.split(/\s+/).some((k) => keys.has(k));
    el.classList.toggle("off-page", !on);
  }
  for (const a of document.querySelectorAll("#coach-subnav a")) {
    a.setAttribute("aria-selected", String(page === "coach" && a.dataset.sub === coachSub()));
  }
  const it = NAV_ITEMS.find((x) => x.id === page);
  document.getElementById("crumbs").innerHTML = "";
  const cr = document.getElementById("crumbs");
  cr.append(`${it.group} / `);
  const b = document.createElement("b");
  b.textContent = it.t;
  cr.append(b);
  for (const [t, sb] of [["page-title", "page-sub"], ["an-title", "an-sub"]]) {
    const te = document.getElementById(t), se = document.getElementById(sb);
    if (te) te.textContent = it.t;
    if (se) se.textContent = it.sub || "";
  }
  document.title = page === "overview" ? "SimDash" : `${it.t} · SimDash`;
}

/** Nach dem Seitenwechsel innerhalb der Analyse: Diagramme neu zeichnen (versteckt hatten sie keine Breite). */
function redrawAnalyse() {
  if (typeof state === "undefined" || !state.detail || currentTab() !== "analyse") return;
  requestAnimationFrame(() => {
    try {
      drawChart(state.detail.laps, state.detail.pb);
      if (analysis.traced.length) renderAnalysis();
      renderCoach();
      renderProgress();
      if (typeof renderHandling === "function" && typeof hdState !== "undefined" && hdState.data) renderHandling();
    } catch (e) { console.error(e); }
  });
}

function shellRoute() {
  renderNav();
  applyPageVisibility();
  document.getElementById("app").classList.remove("drawer-open");
  if (typeof onPageShown === "function") onPageShown(currentPage());
}

/* --- Menü ein-/ausklappen, Schublade am Handy ------------------------------- */
(() => {
  const app = document.getElementById("app");
  if (localStorage.getItem("sd-nav") === "collapsed") app.classList.add("collapsed");
  document.getElementById("nav-collapse").addEventListener("click", () => {
    app.classList.toggle("collapsed");
    localStorage.setItem("sd-nav", app.classList.contains("collapsed") ? "collapsed" : "open");
    setTimeout(() => window.dispatchEvent(new Event("resize")), 260);   // Diagramme an neue Breite anpassen
  });
  document.getElementById("menu-btn").addEventListener("click", () => app.classList.add("drawer-open"));
  document.getElementById("scrim").addEventListener("click", () => app.classList.remove("drawer-open"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") app.classList.remove("drawer-open"); });
  renderNav();
  applyPageVisibility();
})();
