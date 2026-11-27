// SimDash – Sprit-Rechner im Live-Tab. Verbrauch misst er selbst (Sprit an jeder Ziellinie), sonst
// nimmt er den Wert des Spiels. Alles lässt sich überschreiben; Eingaben merkt er sich je Kombination.
"use strict";

const fuel = { marks: [], lastLap: null, session: null, inputs: null };

const fuelKey = () => live.combo ? `simdash.fuel.${comboKey(live.combo)}` : null;
function fuelSaved() { try { return JSON.parse(localStorage.getItem(fuelKey()) || "{}"); } catch { return {}; } }
function fuelSave(patch) { const k = fuelKey(); if (k) localStorage.setItem(k, JSON.stringify({ ...fuelSaved(), ...patch })); }

/** Bei jedem Live-Paket: an der Ziellinie Spritstand merken → Verbrauch je Runde. */
function fuelOnLive(d) {
  const t = d.tele || {};
  if (d.session_uid !== fuel.session) { fuel.session = d.session_uid; fuel.marks = []; fuel.lastLap = null; }
  if (t.fuel == null || d.lap_count == null) return;
  if (fuel.lastLap !== null && d.lap_count === fuel.lastLap + 1) {
    const prev = fuel.marks[fuel.marks.length - 1];
    fuel.marks.push({ lap: d.lap_count, fuel: t.fuel });
    if (prev && prev.lap === d.lap_count - 1) {
      const used = prev.fuel - t.fuel;
      if (used > 0.2 && used < 15) {                    // nachgetankt oder Unsinn → ignorieren
        const s = fuelSaved();
        const hist = [...(s.measured || []), +used.toFixed(3)].slice(-8);
        fuelSave({ measured: hist });
        renderFuel();
      }
    }
  } else if (fuel.lastLap === null || d.lap_count !== fuel.lastLap) {
    fuel.marks = [{ lap: d.lap_count, fuel: t.fuel }];
  }
  fuel.lastLap = d.lap_count;
}

const fuMedian = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : null; };

/** Vorschläge aus den Daten: Verbrauch, Rundenzeit, Tankinhalt. */
function fuelAuto() {
  const d = live.data || {}, t = d.tele || {}, s = fuelSaved();
  const meas = s.measured && s.measured.length ? fuMedian(s.measured.slice(-5)) : null;
  const cons = meas || (t.fuel_lap > 0.3 ? t.fuel_lap : null);
  const sess = live.laps.filter((l) => l.session_uid === d.session_uid && isCounting(l) && !l.outlap && !l.inlap).map((l) => l.lap_time_ms);
  const lapMs = sess.length >= 2 ? fuMedian(sess) : live.pb ? live.pb.lap_time_ms * 1.01 : null;
  return { cons, consSrc: meas ? `gemessen über ${Math.min(5, s.measured.length)} Runden` : cons ? "laut Spiel" : "", lapMs, tank: t.fuel > 0 ? t.fuel : null };
}

function fuelInputs() {
  const box = $("#lv-fuel");
  if (!box || fuel.inputs) return;
  const s = fuelSaved();
  const inp = (id, label, attrs) => h("label", { class: "fu-in" }, h("span", {}, label), h("input", { id, inputmode: "decimal", ...attrs }));
  const unit = h("select", { id: "fu-unit", "aria-label": "Einheit Renndauer" }, h("option", { value: "min" }, "Min."), h("option", { value: "laps" }, "Runden"));
  unit.value = s.unit || "min";
  box.replaceChildren(
    h("div", { class: "fu-grid" },
      h("label", { class: "fu-in" }, h("span", {}, "Renndauer"), h("div", { class: "fu-pair" }, h("input", { id: "fu-len", inputmode: "decimal", value: s.len || "" , placeholder: "z. B. 60" }), unit)),
      inp("fu-lap", "Rundenzeit", { placeholder: "auto", value: s.lap || "" }),
      inp("fu-cons", "Verbrauch l/Runde", { placeholder: "auto", value: s.cons || "" }),
      inp("fu-res", "Reserve (Runden)", { value: s.res ?? "1" }),
      inp("fu-tank", "Im Tank (l)", { placeholder: "auto" })),
    h("div", { class: "fu-out", id: "fu-out", "aria-live": "polite" }));
  for (const el of box.querySelectorAll("input,select")) el.addEventListener("input", () => {
    fuelSave({ len: $("#fu-len").value, unit: $("#fu-unit").value, lap: $("#fu-lap").value, cons: $("#fu-cons").value, res: $("#fu-res").value });
    renderFuel();
  });
  fuel.inputs = true;
}

const numIn = (id) => { const v = parseFloat(String($(id).value).replace(",", ".")); return Number.isFinite(v) ? v : null; };
/** "1:21.5" oder "81.5" → ms */
function parseLap(txt) {
  const m = String(txt).trim().replace(",", ".").match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? ((+m[1] || 0) * 60 + +m[2]) * 1000 : null;
}

function renderFuel() {
  const box = $("#lv-fuel");
  if (!box) return;
  fuelInputs();
  const a = fuelAuto();
  $("#fu-lap").placeholder = a.lapMs ? fmt(Math.round(a.lapMs)) : "1:21.5";
  $("#fu-cons").placeholder = a.cons ? a.cons.toFixed(2).replace(".", DEC) : "z. B. 2,9";
  $("#fu-tank").placeholder = a.tank != null ? a.tank.toFixed(1).replace(".", DEC) : "–";
  const len = numIn("#fu-len"), unit = $("#fu-unit").value;
  const lapMs = parseLap($("#fu-lap").value) || a.lapMs;
  const cons = numIn("#fu-cons") ?? a.cons;
  const res = numIn("#fu-res") ?? 1;
  const tank = numIn("#fu-tank") ?? a.tank;
  const out = $("#fu-out");
  const miss = [!len && "Renndauer", unit === "min" && !lapMs && "Rundenzeit", !cons && "Verbrauch"].filter(Boolean);
  if (miss.length) {
    out.replaceChildren(h("p", { class: "muted-sm" }, `Fehlt noch: ${miss.join(", ")}.${!cons ? " Der Verbrauch wird nach zwei vollen Runden selbst gemessen." : ""}`));
    return;
  }
  // Zeitrennen: nach Ablauf der Uhr wird die angefangene Runde noch zu Ende gefahren → +1
  const laps = unit === "laps" ? Math.ceil(len) : Math.ceil((len * 60000) / lapMs) + 1;
  const need = (laps + res) * cons;
  const add = tank != null ? need - tank : null;
  const v = (x, d = 1) => x.toFixed(d).replace(".", DEC);
  out.replaceChildren(
    h("div", { class: "fu-big" }, h("div", {}, h("small", {}, "Sprit fürs Rennen"), h("b", {}, `${v(Math.ceil(need * 10) / 10)} l`)),
      h("div", {}, h("small", {}, "Runden"), h("b", {}, String(laps))),
      tank != null ? h("div", { class: add > 0 ? "warn" : "" }, h("small", {}, add > 0 ? "nachtanken" : "Reserve übrig"), h("b", {}, `${v(Math.abs(add))} l`)) : null),
    h("p", { class: "muted-sm" }, [
      `${laps} Runden${unit === "min" ? ` (${len} Min. ÷ ${fmt(Math.round(lapMs))}, +1 für die angefangene Runde)` : ""} + ${v(res, 0)} Reserve × ${v(cons, 2)} l`,
      !numIn("#fu-cons") && a.consSrc ? ` · Verbrauch ${a.consSrc}` : "",
      tank != null ? ` · im Tank ${v(tank)} l, reicht für ${v(tank / cons)} Runden` : "",
    ].join("")));
}
$("#lv-fuel-card").addEventListener("toggle", renderFuel);
