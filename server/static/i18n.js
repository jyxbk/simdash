/* Sprache der Oberfläche. Der Quelltext ist deutsch; für Englisch übersetzt diese Datei alle
 * sichtbaren Texte über das Wörterbuch I18N_EN (i18n-en.js) – auch Texte vom Server (Coach-Tipps,
 * Fehlermeldungen). Ein MutationObserver übersetzt neue und geänderte Textknoten sowie title,
 * aria-label und placeholder, bevor der Browser zeichnet. Für Texte außerhalb des DOM
 * (Sprachausgabe, confirm/prompt) gibt es tr().
 * Wahl: localStorage „sd-lang“ (de/en), sonst die Browsersprache. Fehlende Übersetzungen findet
 * ?i18n-debug in der Adresse + I18N.missing() in der Konsole. */
const LANG = (() => {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "de" || q === "en") localStorage.setItem("sd-lang", q);
  const s = localStorage.getItem("sd-lang");
  if (s === "de" || s === "en") return s;
  return (navigator.language || "en").toLowerCase().startsWith("de") ? "de" : "en";
})();
/** Zahlen- und Datumsformat passend zur Sprache. */
const LOCALE = LANG === "de" ? "de-DE" : ((navigator.language || "").startsWith("en") ? navigator.language : "en-GB");
/** Dezimaltrenner für eigene Zahlenformate (x.toFixed(1).replace(".", DEC)). */
const DEC = LANG === "de" ? "," : ".";
/** Kürzel für Runde (R12 / L12). */
const LAP_SHORT = LANG === "de" ? "R" : "L";
document.documentElement.lang = LANG;

const I18N = (() => {
  const on = LANG === "en" && typeof I18N_EN === "object";
  const debug = new URLSearchParams(location.search).has("i18n-debug");
  const exact = new Map();
  const patterns = [];
  const cache = new Map();
  const missing = new Set();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (on) {
    for (const [de, en] of Object.entries(I18N_EN)) {
      const key = de.trim();
      if (!/\{\d\}/.test(key)) { exact.set(key, en.trim()); continue; }
      const parts = key.split(/\{(\d)\}/);           // Text, Index, Text, Index, …, Text
      const order = [];
      let rx = "^";
      for (let i = 0; i < parts.length; i++) {
        // Platzhalter direkt am Wort („kommt{1}“, „…){2}“) darf leer sein: so baut der Code optionale Zusätze an
        const glued = i % 2 && parts[i - 1] && !/\s$/.test(parts[i - 1]);
        if (i % 2) { order.push(Number(parts[i])); rx += glued ? "([\\s\\S]*?)" : "([\\s\\S]+?)"; } else rx += esc(parts[i]);
      }
      const literal = parts.filter((_, i) => i % 2 === 0).join("");
      patterns.push({ prefix: parts[0], suffix: parts[parts.length - 1], re: new RegExp(rx + "$"), order, en: en.trim(), weight: literal.length });
    }
    patterns.sort((a, b) => b.weight - a.weight);    // spezifischste Muster zuerst
  }
  // deutsche Zahl in einem Platzhalter (z. B. „0,72“ aus einer Server-Meldung) → 0.72
  const fixNumber = (s) => (/^[−+\-±]?\d+(,\d+)?\s?[a-z%°/]*$/i.test(s) ? s.replace(/(\d),(\d)/g, "$1.$2") : s);
  // nur typische Wörter, keine Umlaute: Namen wie „Nürburgring“ oder „Jörg“ sollen ein Muster nicht kippen
  const germanWords = (s) => /\b(der|die|das|und|nicht|mit|ein|eine|für|noch|auf|bei|zur|keine?|Runden?|Kurven?|Zeit|Fahrer|Bremse|Lenkung|Gang|gültig|ungültig|du|dein|deine|ist|oder|als|von|bis|aus|im|am|zu|wird|schiebt|Gas|Scheitel|Heck|später|früher|mehr|weniger)\b/.test(s);
  const looksGerman = (s) => /[äöüÄÖÜß]|\b(der|die|das|und|nicht|mit|ein|eine|für|noch|auf|bei|zur|keine?|Runden?|Kurven?|Zeit|Strecke|Fahrer|Bremse|Lenkung|Gang|gültig|ungültig|du|dein|deine|ist|oder|als|von|bis|aus|im|am|zu|wird|Sitzung|Auto|Spiel|Tempo)\b/.test(s);

  /** Platzhalter einsetzen; null, wenn ein Platzhalter deutschen Text enthält, der sich nicht übersetzen
   *  lässt – dann ist es vermutlich das falsche Muster (z. B. „Ausgang: {0}“ statt „{0}: schiebt …“). */
  function fill(p, m, depth) {
    let failed = false;
    const out = p.en.replace(/\{(\d)\}/g, (_, n) => {
      const v = m[p.order.indexOf(Number(n)) + 1] ?? "";
      if (!v.trim()) return v;
      const t = core(v.trim(), depth + 1);
      if (t != null) return v.replace(v.trim(), t);
      if (germanWords(v)) failed = true;
      return fixNumber(v);
    });
    return failed ? null : out;
  }
  function byPattern(s, depth, leading) {
    for (const p of patterns) {
      if ((p.prefix === "") !== leading || !s.startsWith(p.prefix) || !s.endsWith(p.suffix)) continue;
      const m = p.re.exec(s);
      const out = m && fill(p, m, depth);
      if (out != null) return out;
    }
    return null;
  }
  /** Zusammengesetzte Texte („Tipp · Tipp“, „· Zusatz“, „8× A, 2× B“) stückweise übersetzen. */
  function bySplit(s, depth) {
    const lead = /^([·•–]\s+)([\s\S]+)$/.exec(s);
    if (lead) { const t = core(lead[2], depth + 1); return t != null ? lead[1] + t : null; }
    for (const sep of [" · ", ", ", " / "]) {
      if (!s.includes(sep)) continue;
      const parts = s.split(sep);
      let changed = false, ok = true;
      const out = parts.map((x) => {
        if (!/[A-Za-zÄÖÜäöü]{2}/.test(x)) return x;
        const t = core(x.trim(), depth + 1);
        if (t == null) { ok = false; return x; }
        changed = true;
        return x.replace(x.trim(), t);
      });
      // bei „, “ nur, wenn jedes Stück bekannt ist (sonst zerreißt es normale Sätze)
      if (changed && (ok || sep === " · ")) return out.join(sep);
    }
    // „T11 +0,79: Dein Scheiteltempo …“ – Kürzel vorne behalten, Satz dahinter übersetzen
    const colon = /^([^:]{1,40}):\s([\s\S]+)$/.exec(s);
    if (colon && !germanWords(colon[1])) {
      const t = core(colon[2], depth + 1);
      if (t != null) return `${core(colon[1], depth + 1) ?? fixNumber(colon[1])}: ${t}`;
    }
    return null;
  }
  function core(s, depth) {
    const hit = exact.get(s);
    if (hit != null) return hit;
    if (depth > 4) return null;
    return byPattern(s, depth, false) ?? bySplit(s, depth) ?? byPattern(s, depth, true);
  }

  /** Übersetzt einen Text; Leerraum am Rand bleibt erhalten. Ohne Treffer: unverändert. */
  function tr(s) {
    if (!on || s == null || s === "") return s;
    s = String(s);
    const c = cache.get(s);
    if (c !== undefined) return c;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    let out = s;
    if (m[2] && /[A-Za-zÄÖÜäöü]/.test(m[2])) {
      const t = core(m[2], 0);
      if (t != null) out = m[1] + t + m[3];
      else if (debug && looksGerman(m[2])) missing.add(m[2]);
    }
    if (cache.size > 5000) cache.clear();
    cache.set(s, out);
    return out;
  }

  const ATTRS = ["title", "aria-label", "placeholder"];
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE"]);
  const done = new WeakMap();                         // Knoten → zuletzt gesetzter Text (keine Schleifen)
  function textNode(n) {
    const v = n.nodeValue;
    if (done.get(n) === v || (n.parentNode && SKIP.has(n.parentNode.nodeName))) return;
    const t = tr(v);
    done.set(n, t);
    if (t !== v) n.nodeValue = t;
  }
  function attrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) { const t = tr(v); if (t !== v) el.setAttribute(a, t); }
    }
  }
  function walk(root) {
    if (root.nodeType === 3) return textNode(root);
    if (root.nodeType !== 1) return;
    attrs(root);
    if (SKIP.has(root.nodeName)) return;
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      if (n.nodeType === 3) textNode(n); else attrs(n);
    }
  }
  if (on) {
    walk(document.body);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData") textNode(m.target);
        else if (m.type === "attributes") attrs(m.target);
        else for (const n of m.addedNodes) walk(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    for (const f of ["alert", "confirm"]) { const orig = window[f].bind(window); window[f] = (msg) => orig(tr(msg)); }
    const origPrompt = window.prompt.bind(window);
    window.prompt = (msg, def) => origPrompt(tr(msg), def);
  }
  return { tr, missing: () => [...missing].sort() };
})();
const tr = I18N.tr;

/* Umschalter DE/EN unten im Menü */
(() => {
  const foot = document.querySelector(".sb-foot");
  if (!foot) return;
  const box = document.createElement("div");
  box.className = "lang-switch";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", LANG === "de" ? "Sprache" : "Language");
  for (const l of ["de", "en"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = l.toUpperCase();
    b.setAttribute("aria-pressed", String(l === LANG));
    b.addEventListener("click", () => {
      if (l === LANG) return;
      localStorage.setItem("sd-lang", l);
      const u = new URL(location.href);
      if (u.searchParams.has("lang")) { u.searchParams.delete("lang"); location.href = u.href; } else location.reload();
    });
    box.append(b);
  }
  foot.append(box);
})();
