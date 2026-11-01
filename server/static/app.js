"use strict";

const $ = (s) => document.querySelector(s);
const sel = { game: $("#f-game"), track: $("#f-track"), car: $("#f-car") };

const GAME_NAMES = { acevo: "AC EVO", acc: "ACC", ac: "Assetto Corsa", acrally: "AC Rally", iracing: "iRacing" };
const SESSION_NAMES = {
  practice: "Training", qualify: "Qualifying", race: "Rennen", hotlap: "Hotlap",
  time_attack: "Time Attack", hot_stint: "Hot Stint", cruise: "Cruise", superpole: "Superpole",
  time_trial: "Time Trial", testing: "Testfahrt", warmup: "Warm-up",
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Interne IDs wie "road_atlanta" oder "ks_porsche_911_gt3_r" lesbar machen.
function pretty(id) {
  if (!id) return "";
  const upper = new Set(["bmw", "amg", "gt", "gtr", "gte", "lmp", "lmh", "lmdh", "ks"]);
  return String(id).replace(/^ks_/, "").replace(/[_-]+/g, " ")
    .split(" ").map((w) => (/\d/.test(w) || upper.has(w.toLowerCase())) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function trackName(lap) {
  return pretty(lap.track) + (lap.layout ? ` · ${pretty(lap.layout)}` : "");
}

function fmt(ms) {
  if (ms == null) return "–";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function badges(lap) {
  const b = [];
  if (lap.valid === false) b.push('<span class="badge bad">ungültig</span>');
  if (lap.estimated) b.push('<span class="badge warn" title="Aus der laufenden Zeit geschätzt (Rundenzähler fehlte, z. B. Verbindungsabbruch)">geschätzt</span>');
  if (lap.outlap) b.push('<span class="badge">Outlap</span>');
  if (lap.inlap) b.push('<span class="badge">Inlap</span>');
  if (lap.note) b.push(`<span class="badge" title="${esc(lap.note)}">📝</span>`);
  return b.join("");
}

function params() {
  const p = new URLSearchParams();
  for (const [k, el] of Object.entries(sel)) if (el.value) p.set(k, el.value);
  return p;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function fillSelect(el, values, label) {
  const cur = el.value;
  el.innerHTML = `<option value="">${label}</option>` +
    values.map((v) => `<option value="${esc(v)}">${esc(el === sel.game ? (GAME_NAMES[v] || v) : pretty(v))}</option>`).join("");
  if (values.includes(cur)) el.value = cur;
}

function renderBests(list) {
  const box = $("#bests");
  if (!list.length) { box.replaceChildren($("#tpl-empty").content.cloneNode(true)); return; }
  box.innerHTML = list.map((c) => {
    const v = c.best_valid, a = c.best_any;
    const showAlt = a && (!v || a.id !== v.id);
    return `<div class="card">
      <div class="combo">${esc(trackName(c))}</div>
      <div class="sub">${esc(pretty(c.car))} · ${esc(GAME_NAMES[c.game] || c.game)}</div>
      <div class="time">${v ? fmt(v.lap_time_ms) : "–"}</div>
      <div class="alt">${v ? fmtDate(v.recorded_at) : "keine gültige Runde"}${showAlt ? ` · schnellste insg. ${fmt(a.lap_time_ms)}${badges(a)}` : ""}</div>
      <div class="alt">${c.laps} ${c.laps === 1 ? "Runde" : "Runden"} · zuletzt ${fmtDate(c.last_driven)}</div>
    </div>`;
  }).join("");
}

function renderLaps(laps, bests) {
  const box = $("#laps");
  if (!laps.length) { box.replaceChildren($("#tpl-empty").content.cloneNode(true)); return; }
  const pbIds = new Set(bests.map((c) => c.best_valid && c.best_valid.id).filter(Boolean));
  let html = `<table><thead><tr><th>Zeit</th><th>Runde</th><th class="hide-sm">Strecke / Auto</th><th class="hide-sm">Wann</th></tr></thead><tbody>`;
  let lastSession = null;
  for (const lap of laps) {
    if (lap.session_uid !== lastSession) {
      lastSession = lap.session_uid;
      const st = SESSION_NAMES[lap.session_type] || lap.session_type || "Session";
      html += `<tr class="session-head"><td colspan="4">${esc(GAME_NAMES[lap.game] || lap.game)} · ${esc(trackName(lap))} · ${esc(pretty(lap.car))} · ${esc(st)}${lap.online ? " · online" : ""} · ${fmtDate(lap.recorded_at)}</td></tr>`;
    }
    const cls = [pbIds.has(lap.id) ? "pb" : "", lap.valid === false ? "invalid" : ""].join(" ");
    html += `<tr class="${cls}">
      <td class="t">${fmt(lap.lap_time_ms)}</td>
      <td>${lap.lap_number ?? ""}${badges(lap)}${pbIds.has(lap.id) ? '<span class="badge good">PB</span>' : ""}</td>
      <td class="hide-sm">${esc(trackName(lap))}<br><span class="muted">${esc(pretty(lap.car))}</span></td>
      <td class="hide-sm muted">${fmtDate(lap.recorded_at)}</td>
    </tr>`;
  }
  box.innerHTML = html + "</tbody></table>";
}

async function load() {
  try {
    const p = params();
    const [f, b, l] = await Promise.all([
      getJSON("/api/filters"),
      getJSON(`/api/bests?${p}`),
      getJSON(`/api/laps?limit=200&${p}`),
    ]);
    fillSelect(sel.game, f.games, "Alle Spiele");
    fillSelect(sel.track, f.tracks, "Alle Strecken");
    fillSelect(sel.car, f.cars, "Alle Autos");
    renderBests(b);
    renderLaps(l, b);
    $("#status").textContent = `${f.total} Runden · aktualisiert ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (e) {
    $("#status").textContent = "Server nicht erreichbar";
    console.error(e);
  }
}

for (const el of Object.values(sel)) el.addEventListener("change", load);
load();
setInterval(() => { if (!document.hidden) load(); }, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
