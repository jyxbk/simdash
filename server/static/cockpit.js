// SimDash – Cockpit: Vollbild fürs Handy am Rig (#cockpit). Ein Bildschirm, kein Scrollen,
// Display bleibt an, Verbindung baut sich selbst wieder auf. Daten wie im Live-Tab (live.js).
"use strict";

const cp = { started: false, video: null, lastRx: 0, detail: false };
/** Handy: schmal (hoch) oder quer mit wenig Höhe. */
const cpPhone = () => matchMedia("(max-width: 760px), (max-height: 500px)").matches;
/** Cockpit zeigen? Immer bei #cockpit; am Handy ist es die Live-Ansicht (außer „Details“ gewählt). */
const isCockpit = () => location.hash === "#cockpit" || (location.hash === "#live" && cpPhone() && !cp.detail);
function cpSync() {
  if (currentTab() === "live" && isCockpit()) cpEnter(); else cpLeave();
}

/* --- Display anlassen ------------------------------------------------------------
   Wake Lock gibt es nur über HTTPS. SimDash läuft im LAN über HTTP → zusätzlich ein stummes
   Mini-Video in Endlosschleife (so halten auch iPhone und Android das Display an). */
async function cpKeepAwake() {
  try { if ("wakeLock" in navigator && window.isSecureContext && !live.wake) live.wake = await navigator.wakeLock.request("screen"); } catch { /* weiter mit Video */ }
  if (!cp.video) {
    cp.video = h("video", { class: "cp-keepawake", src: "/static/keepawake.mp4", muted: true, loop: true, playsinline: true, "aria-hidden": "true" });
    cp.video.muted = true;
    document.body.append(cp.video);
  }
  try { await cp.video.play(); } catch { /* braucht Antippen */ }
}
function cpRelease() {
  if (cp.video) { cp.video.pause(); }
}

/** Antippen zum Start: Vollbild (wo erlaubt), Querformat sperren (Android), Display an. */
async function cpStart() {
  cp.started = true;
  $("#cp-start").hidden = true;
  const el = document.documentElement;
  try { if (el.requestFullscreen && !document.fullscreenElement) await el.requestFullscreen({ navigationUI: "hide" }); } catch { /* iPhone: über Home-Bildschirm */ }
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock("landscape"); } catch { /* egal */ }
  await cpKeepAwake();
}

function cpExit(to) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  cpRelease();
  cp.started = false;
  if (to === "detail") { cp.detail = true; if (location.hash !== "#live") location.hash = "#live"; else cpSync(); }
  else location.hash = "#";
}

function cpEnter() {
  document.body.classList.add("cockpit");
  $("#cockpit-view").hidden = false;
  const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches;
  $("#cp-start").hidden = cp.started;
  $("#cp-start-hint").hidden = !(/iPhone|iPad/.test(navigator.userAgent) && !standalone);
  renderCockpit();
}
function cpLeave() {
  document.body.classList.remove("cockpit");
  $("#cockpit-view").hidden = true;
  cpRelease();
}

/* --- Verbindung überwachen: kommen 6 s keine Daten, Stream neu aufbauen ---------- */
setInterval(() => {
  if (currentTab() !== "live" || document.hidden) return;
  if (live.es && (live.es.readyState === 2 || performance.now() - (live.rxAt || 0) > 6000)) {
    live.es.close(); live.es = null; startLive();
  }
  if (isCockpit()) renderCockpitConn();
}, 2000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden || currentTab() !== "live") return;
  if (live.es) { live.es.close(); live.es = null; }
  startLive();
  if (isCockpit() && cp.started) cpKeepAwake();
});

/* --- Zeichnen ------------------------------------------------------------------ */
function cpSec(ms, d = 3) {
  const txt = (Math.abs(ms) / 1000).toFixed(d).replace(".", ",");
  return `${/^[0,]+$/.test(txt) ? "±" : ms < 0 ? "−" : "+"}${txt}`;
}

function renderCockpitConn() {
  const dot = $("#cp-conn"), txt = $("#cp-conn-txt");
  const d = live.data;
  const stale = isStale();
  let cls = "off", label = "keine Verbindung – verbinde neu …";
  if (live.es && live.rxAt && !stale && d && d.state === "live") { cls = "on"; label = "live"; }
  else if (live.es && live.rxAt && performance.now() - live.rxAt < 6000) { cls = "idle"; label = d && d.game ? (d.paused ? "Pause" : "wartet aufs Spiel") : "kein Spiel aktiv"; }
  dot.className = `cp-dot ${cls}`;
  txt.textContent = label;
}

function renderCockpit() {
  if (!isCockpit()) return;
  renderCockpitConn();
  const d = live.data;
  const pb = live.pb;
  $("#cp-what").textContent = d && d.game ? `${trackName(d)} · ${pretty(d.car)}` : "SimDash Cockpit";

  // Status: gültig / Box / Outlap, Sprit
  const flags = [];
  if (d && d.in_pit_lane) flags.push(h("span", { class: "cp-flag pit" }, "BOX"));
  if (d && d.lap_outlap) flags.push(h("span", { class: "cp-flag" }, "OUTLAP"));
  if (d && d.lap_invalid) flags.push(h("span", { class: "cp-flag bad" }, "✕ UNGÜLTIG"));
  const t = (d && d.tele) || {};
  const fl = t.fuel_laps > 0 && t.fuel_lap > 0.3 ? t.fuel_laps : null;
  if (fl != null) flags.push(h("span", { class: `cp-flag ${fl < 2 ? "warn" : ""}` }, `⛽ ${fl.toFixed(1).replace(".", ",")} R`));
  $("#cp-flags").replaceChildren(...flags);

  // Delta – das Wichtigste, riesig und farbig
  const delta = d && d.game ? liveDelta(d) : null;
  const box = $("#cp-delta-box");
  box.classList.toggle("loss", delta != null && delta > 0);
  box.classList.toggle("gain", delta != null && delta <= 0);
  const strength = delta == null ? 0 : Math.min(1, Math.abs(delta) / 1500);
  box.style.setProperty("--tint", (0.12 + 0.38 * strength).toFixed(2));
  $("#cp-delta").textContent = delta == null ? "–" : cpSec(delta, Math.abs(delta) < 10000 ? 2 : 1);
  $("#cp-delta-sub").textContent = !pb ? "noch keine Bestzeit" : delta == null ? `Bestzeit ${fmt(pb.lap_time_ms)}` : `Prognose ${fmt(Math.round(pb.lap_time_ms + delta))}`;

  // Rundenzeiten
  $("#cp-lapno").textContent = d && d.game ? `Runde ${d.lap_count + 1}` : "Runde";
  const last = d && d.last_ms > 0 ? d.last_ms : null;
  $("#cp-last").replaceChildren("Letzte ", h("b", {}, last ? fmt(last) : "–"),
    last && pb ? h("span", { class: last > pb.lap_time_ms ? "loss" : "gain" }, ` ${cpSec(last - pb.lap_time_ms, 2)}`) : "");
  $("#cp-best").replaceChildren("Bestzeit ", h("b", {}, pb ? fmt(pb.lap_time_ms) : "–"));

  // Tempo, Gang, Pedale
  $("#cp-speed").textContent = d && d.speed_kmh != null ? Math.round(d.speed_kmh) : "–";
  const gr = live.gearShown;
  $("#cp-gear").textContent = gr == null ? "–" : gr < 0 ? "R" : gr === 0 ? "N" : String(gr);
  $("#cp-thr").style.width = d && d.throttle != null ? `${Math.round(d.throttle * 100)}%` : "0";
  $("#cp-brk").style.width = d && d.brake != null ? `${Math.round(d.brake * 100)}%` : "0";
  const rpm = $("#cp-rpm");
  if (d && d.rpm_pct != null) { rpm.style.width = `${Math.round(d.rpm_pct * 100)}%`; rpm.classList.toggle("hot", d.rpm_pct > 0.94); }
  else rpm.style.width = "0";

  // 10 Abschnitte gegen die Bestzeit
  const pbS = live.pbSectors;
  const cur = d ? Math.min(SECTORS - 1, Math.floor((d.npos || 0) * SECTORS)) : -1;
  const cells = [];
  for (let k = 0; k < SECTORS; k++) {
    const a = live.bounds[k], b = live.bounds[k + 1];
    let cls = "cp-sec", val = "";
    if (a != null && b != null && pbS && pbS[k] != null) {
      const dd = (b - a) - pbS[k];
      cls += dd > 0 ? " loss" : " gain";
      val = cpSec(dd, 2);
    } else if (k === cur && d && d.state === "live") cls += " now";
    cells.push(h("div", { class: cls }, val));
  }
  $("#cp-sectors").replaceChildren(...cells);

  // Coach nach der Runde: größte Baustelle mit Tipp
  const r = live.coachData;
  const line = $("#cp-coach");
  if (r && r.ok) {
    const worst = r.corners.filter((c) => c.loss_ms >= 30).sort((a, b) => b.loss_ms - a.loss_ms)[0];
    const head = `R${r.lap.lap_number ?? "?"} ${cpSec(r.delta_ms, 2)}`;
    line.replaceChildren(h("b", {}, head), worst
      ? h("span", {}, ` · ${cornerShort(worst)} ${cpSec(worst.loss_ms, 2)}${worst.tips && worst.tips[0] ? ": " + worst.tips[0].text : ""}`)
      : h("span", {}, " · in keiner Kurve langsamer"));
  } else line.textContent = "Nach jeder Runde steht hier, wo die meiste Zeit liegt.";
}

/** Laufende Uhr flüssig (aus tick() in live.js aufgerufen). */
function tickCockpit(ms) {
  if (!isCockpit()) return;
  $("#cp-time").textContent = ms > 0 ? fmt(Math.round(ms)) : "–";
}

$("#cp-start").addEventListener("click", cpStart);
$("#cp-exit").addEventListener("click", () => cpExit("overview"));
$("#cp-detail").addEventListener("click", () => cpExit("detail"));
$("#cp-open").addEventListener("click", () => {
  cp.detail = false;
  if (location.hash !== "#live" && location.hash !== "#cockpit") location.hash = cpPhone() ? "#live" : "#cockpit";
  else if (!cpPhone()) location.hash = "#cockpit";
  cpSync(); cpStart();
});
// Drehen oder Fenstergröße ändern: Handy-Erkennung neu
window.addEventListener("resize", () => { if (currentTab() === "live") cpSync(); });
// Andere Tabs: beim nächsten Öffnen von Live am Handy wieder das Cockpit
window.addEventListener("hashchange", () => { if (currentTab() !== "live") cp.detail = false; });
// Im Cockpit tippen holt Vollbild/Display-Sperre zurück (z. B. nach Sperrbildschirm)
$("#cockpit-view").addEventListener("click", (e) => { if (e.target.closest("button")) return; if (cp.started) cpKeepAwake(); });
// Direkt mit /#cockpit geöffnet (z. B. vom Home-Bildschirm): showTab lief schon vor diesem Skript
cpSync();
