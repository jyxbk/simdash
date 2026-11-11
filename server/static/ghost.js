"use strict";
// ---------------------------------------------------------------------------
// Ghost-Coach (Hinweis vor jeder Kurve mit Potenzial, aus deiner eigenen Bestfahrt dort)
// und Sprachansagen (Web Speech API im Browser, z. B. am Handy am Rig).
// Daten: /api/coach für die live gefahrene Kombination. Aufruf: ghostOnLive(d, prev) aus live.js.
// ---------------------------------------------------------------------------
const GHOST_MIN_GAIN = 30;        // ms – erst ab hier lohnt ein Hinweis
const GHOST_LEAD_M = 220;         // so weit vor dem Kurvenbeginn erscheint der Hinweis
const ghost = { key: null, corners: [], lead: 0.05, lapKey: null, done: new Set(), cur: null, loadedAt: 0,
  awaitLap: null, fuelSaid: new Set(), invalidSaid: null };
const VOICE_DEFAULT = { on: false, coach: true, laps: true, invalid: true, fuel: true };
const voice = Object.assign({}, VOICE_DEFAULT, JSON.parse(localStorage.getItem("sd-voice") || "{}"));
const saveVoice = () => localStorage.setItem("sd-voice", JSON.stringify(voice));

/** Kurzer Hinweis je Tipp-Art: Anzeige (show) und Sprache (say). */
function ghostPhrase(c) {
  const name = c.name || `Kurve ${c.no}`;
  const t = (c.tips || [])[0];
  if (!t) return null;
  const v = t.value;
  const P = {
    brake_later: [`${v} m später bremsen`, `${v} Meter später bremsen`],
    brake_earlier: [`${v} m früher bremsen, mehr Tempo mit`, `${v} Meter früher bremsen`],
    carry_speed: [`+${v} km/h im Scheitel`, `${v} schneller durch den Scheitel`],
    throttle_earlier: [`${v} m früher voll aufs Gas`, `${v} Meter früher aufs Gas`],
    better_exit: ["sauberer raus, früher aufs Gas", "sauber raus"],
    entry_speed: [`+${v} km/h rein`, "mehr Tempo rein"],
    gear_higher: ["einen Gang höher", "einen Gang höher"],
    gear_lower: ["einen Gang tiefer", "einen Gang tiefer"],
    steer_calmer: ["ruhiger lenken", "ruhiger lenken"],
    less_lock: ["sanfter einlenken", "sanfter einlenken"],
    brake_later_ok: ["ruhiger rein", "ruhiger rein"],
    turn_in_later: [`${v} m später einlenken`, `${v} Meter später einlenken`],
    turn_in_earlier: [`${v} m früher einlenken`, `${v} Meter früher einlenken`],
    unwind_earlier: [`Lenkung ${v} m früher auf`, "Lenkung früher aufmachen"],
    fewer_corrections: ["einmal einlenken, Winkel halten", "einmal einlenken und halten"],
    no_countersteer: ["Gas weicher, Heck ruhig", "Gas weicher"],
    entry: ["Anbremsen und Einlenken sauberer", "sauberer rein"],
    exit: ["früher und sauberer rausbeschleunigen", "früher raus"],
  }[t.kind];
  if (!P) return { name, show: t.text, say: `${name}. ${t.text}` };
  return { name, show: P[0], say: `${name}. ${P[1]}` };
}

async function ghostLoad(combo) {
  const key = comboKey(combo) + "|" + (live.driver || "");
  if (ghost.key === key && Date.now() - ghost.loadedAt < 120000) return;
  ghost.key = key; ghost.loadedAt = Date.now(); ghost.corners = []; ghost.cur = null;
  const q = new URLSearchParams({ game: combo.game, track: combo.track, layout: combo.layout || "", car: combo.car });
  if (live.driver) q.set("driver", live.driver);
  try {
    const r = await getJSON(`/api/coach?${q}`);
    if (ghost.key !== key) return;
    const len = r.track_length_m || 0;
    ghost.lead = len > 500 ? Math.min(0.08, GHOST_LEAD_M / len) : 0.05;
    ghost.corners = (r.corners || []).filter((c) => (c.gain_ms || 0) >= GHOST_MIN_GAIN && c.tips && c.tips.length)
      .map((c) => ({ ...c, phrase: ghostPhrase(c) })).filter((c) => c.phrase);
  } catch (e) { console.error(e); }
}

/** Liegt npos im Fenster [a, b) auf dem Rundenkreis? */
const inWindow = (n, a, b) => (a <= b ? n >= a && n < b : n >= a || n < b);

function ghostOnLive(d, prev) {
  if (!d || !d.game) return;
  if (live.combo) ghostLoad(live.combo);
  const lapKey = `${d.session_uid}|${d.lap_count}`;
  if (lapKey !== ghost.lapKey) { ghost.lapKey = lapKey; ghost.done = new Set(); ghost.cur = null; }
  const driving = d.state === "live" && !d.paused && !d.in_pit_lane && (d.speed_kmh || 0) > 40;

  // Kurvenhinweis
  if (driving && d.npos != null) {
    for (const c of ghost.corners) {
      const a = (c.start - ghost.lead + 1) % 1;
      if (!ghost.done.has(c.no) && inWindow(d.npos, a, c.apex)) {
        ghost.done.add(c.no);
        ghost.cur = c;
        if (voice.on && voice.coach) speak(c.phrase.say, "coach");
      }
    }
    if (ghost.cur && !inWindow(d.npos, (ghost.cur.start - ghost.lead + 1) % 1, (ghost.cur.apex + 0.01) % 1)) ghost.cur = null;
  }
  renderGhost();

  // Sprachansagen außerhalb des Coachs
  if (!voice.on) return;
  if (prev && prev.session_uid === d.session_uid && d.lap_count === prev.lap_count && d.lap_invalid && !prev.lap_invalid
      && voice.invalid && ghost.invalidSaid !== lapKey) {
    ghost.invalidSaid = lapKey; speak("Runde ungültig", "info");
  }
  // Runde fertig: auf die neue Zeit warten (der Zähler kommt oft vor last_ms), höchstens 3 s
  if (prev && prev.session_uid === d.session_uid && d.lap_count > prev.lap_count) {
    ghost.awaitLap = { oldMs: prev.last_ms, invalid: !!prev.lap_invalid, outlap: !!prev.lap_outlap, at: performance.now() };
  }
  const w = ghost.awaitLap;
  if (w && d.last_ms > 0 && (d.last_ms !== w.oldMs || performance.now() - w.at > 3000)) {
    ghost.awaitLap = null;
    if (voice.laps && !w.outlap) {
      const pb = live.pb && live.pb.lap_time_ms;
      let txt = sayTime(d.last_ms);
      if (w.invalid) txt = `Ungültig. ${txt}`;
      else if (pb && d.last_ms < pb) txt = `Neue Bestzeit! ${txt}`;
      else if (pb) txt += `. ${sayDelta(d.last_ms - pb)}`;
      speak(txt, "lap");
    }
  }
  const fl = d.tele && d.tele.fuel_laps > 0 && d.tele.fuel_lap > 0.3 ? d.tele.fuel_laps : null;
  if (voice.fuel && fl != null && driving) {
    for (const lim of [3, 1.5]) {
      const k = `${d.session_uid}|${lim}`;
      if (fl < lim && !ghost.fuelSaid.has(k)) { ghost.fuelSaid.add(k); speak(`Sprit für noch ${Math.max(1, Math.floor(fl))} ${Math.floor(fl) === 1 ? "Runde" : "Runden"}`, "info"); }
    }
  }
}

function sayTime(ms) {
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), z = Math.floor((ms % 1000) / 100);
  return m ? `${m} ${String(s).padStart(2, "0")} Komma ${z}` : `${s} Komma ${z}`;
}
function sayDelta(dms) {
  const a = Math.abs(dms) / 1000;
  const v = a < 1 ? `${Math.round(a * 10) || 1} Zehntel` : `${a.toFixed(1).replace(".", " Komma ")} Sekunden`;
  return `${v} ${dms <= 0 ? "schneller" : "langsamer"}`;
}

/* --- Sprache ------------------------------------------------------------------ */
let deVoice = null;
function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  deVoice = vs.find((v) => /^de(-|_)DE/i.test(v.lang) && /google|anna|helena|katja|markus|petra|yannick/i.test(v.name)) || vs.find((v) => /^de/i.test(v.lang)) || null;
}
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

/** Ansage: Coach-Hinweise verdrängen ältere Ansagen (veraltete Infos stören mehr als sie nützen). */
function speak(text, kind) {
  if (!window.speechSynthesis) return;
  if (kind === "coach" && speechSynthesis.speaking) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "de-DE";
  if (deVoice) u.voice = deVoice;
  u.rate = 1.15;
  speechSynthesis.speak(u);
}

/* --- Anzeige ------------------------------------------------------------------ */
function renderGhost() {
  const el = $("#cp-ghost");
  if (!el) return;
  const c = ghost.cur;
  el.classList.toggle("on", !!c);
  if (!c) { el.replaceChildren(); return; }
  el.replaceChildren(h("span", { class: "g-name" }, c.phrase.name), h("span", { class: "g-txt" }, c.phrase.show),
    h("span", { class: "g-gain" }, `−${(c.gain_ms / 1000).toFixed(2).replace(".", ",")} s`));
}

function renderVoiceBtn() {
  const b = $("#cp-voice");
  if (b) { b.textContent = voice.on ? "🔊 Ansagen an" : "🔇 Ansagen aus"; b.setAttribute("aria-pressed", String(voice.on)); }
  const box = $("#lv-voice");
  if (box) {
    for (const inp of box.querySelectorAll("input[data-k]")) inp.checked = !!voice[inp.dataset.k];
  }
}
function toggleVoice(on = !voice.on) {
  voice.on = on; saveVoice(); renderVoiceBtn();
  if (window.speechSynthesis) { speechSynthesis.cancel(); if (on) speak(ghost.corners.length ? "Ansagen an. Coach bereit." : "Ansagen an.", "info"); }   // Antippen schaltet die Sprache am Handy frei
}
$("#cp-voice").addEventListener("click", (e) => { e.stopPropagation(); toggleVoice(); });
for (const inp of document.querySelectorAll("#lv-voice input[data-k]")) {
  inp.addEventListener("change", () => { voice[inp.dataset.k] = inp.checked; saveVoice(); if (inp.dataset.k === "on") toggleVoice(inp.checked); });
}
$("#lv-voice-test").addEventListener("click", () => speak("Kurve 9. 3 schneller durch den Scheitel", "coach"));
if (!window.speechSynthesis) { $("#cp-voice").hidden = true; $("#lv-voice").hidden = true; }
renderVoiceBtn();
