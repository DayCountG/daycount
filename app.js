"use strict";
/* ============================================================
   Konstanten
   ============================================================ */
const DAY = 86400000, WINDOW = 180, LIMIT = 90, SOON = 30, MAX_RANGE_DAYS = 3660;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CODES = ["AT","BE","BG","HR","CZ","DK","EE","FI","FR","DE","GR","HU","IS","IT","LV","LI","LT","LU","MT","NL","NO","PL","PT","RO","SK","SI","ES","SE","CH"];
const EN_NAMES = ["Austria","Belgium","Bulgaria","Croatia","Czechia","Denmark","Estonia","Finland","France","Germany","Greece","Hungary","Iceland","Italy","Latvia","Liechtenstein","Lithuania","Luxembourg","Malta","Netherlands","Norway","Poland","Portugal","Romania","Slovakia","Slovenia","Spain","Sweden","Switzerland"];
/* ============================================================
   Sprachen – jede Sprache liegt in i18n/<code>.js und wird erst bei Bedarf geladen
   ============================================================ */
const LANGS = [
  ["de","Deutsch"],["en","English"],["sq","Shqip"],["az","Azərbaycanca"],["id","Bahasa Indonesia"],["bs","Bosanski"],["cs","Čeština"],["da","Dansk"],["et","Eesti"],
  ["es","Español"],["fr","Français"],["ga","Gaeilge"],["hr","Hrvatski"],["is","Íslenska"],["it","Italiano"],["lv","Latviešu"],["lt","Lietuvių"],["hu","Magyar"],
  ["mt","Malti"],["nl","Nederlands"],["no","Norsk"],["pl","Polski"],["pt","Português"],["ro","Română"],["sr","Srpski"],["sk","Slovenčina"],["sl","Slovenščina"],
  ["fi","Suomi"],["sv","Svenska"],["vi","Tiếng Việt"],["tr","Türkçe"],["el","Ελληνικά"],["bg","Български"],["mk","Македонски"],["ru","Русский"],["uk","Українська"],
  ["ka","ქართული"],["hy","Հայերեն"],["he","עברית"],["ar","العربية"],["ur","اردو"],["fa","فارسی"],["hi","हिन्दी"],["bn","বাংলা"],["th","ไทย"],
  ["zh","中文"],["ja","日本語"],["ko","한국어"]
];
const LANG_CODES = LANGS.map(l => l[0]);
const RTL = new Set(["ar", "fa", "ur", "he"]);
const DICTS = {};
window.I18N_ADD = (code, dict) => { DICTS[code] = dict; };
function loadLang(code) {
  if (DICTS[code]) return Promise.resolve();
  return new Promise(res => {
    const s = document.createElement("script");
    s.src = `i18n/${code}.js`; s.onload = res; s.onerror = res;
    document.head.appendChild(s);
  });
}
function detectLang() {
  const saved = lsGet("s9_lang");
  if (LANG_CODES.includes(saved)) return saved;
  for (const l of (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"])) {
    let c = String(l).toLowerCase().split("-")[0];
    if (c === "nb" || c === "nn") c = "no";
    if (LANG_CODES.includes(c)) return c;
  }
  return "en";
}
const intlLoc = () => S.lang === "no" ? "nb" : S.lang;
const D = () => DICTS[S.lang] || DICTS.en || {};
function pluralCat(n) {
  try { if (Intl.PluralRules.supportedLocalesOf([intlLoc()]).length) return new Intl.PluralRules(intlLoc()).select(n); } catch (e) {}
  return n === 1 ? "one" : "other";
}
const fillPos = (s, a) => String(s).replace(/\{(\d)\}/g, (_, i) => a[i] == null ? "" : a[i]);
const fillNamed = (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => o[k] == null ? "" : o[k]);
function rawText(k) { const d = D(); return d[k] !== undefined ? d[k] : (DICTS.en || {})[k]; }
function wrapText(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return (...a) => fillPos(v[pluralCat(Number(a[0]))] !== undefined ? v[pluralCat(Number(a[0]))] : v.other, a);
  if (typeof v === "string" && /\{\d\}/.test(v)) return (...a) => fillPos(v, a);
  return v;
}
const TPROXY = new Proxy({}, { get(_, k) { const v = rawText(k); return v === undefined ? "" : wrapText(v); } });
// Text mit fett hervorgehobenen Platzhaltern (HTML-sicher)
function boldFill(k, ...vals) { const raw = rawText(k); const s = typeof raw === "object" ? raw.other : raw; return esc(s).replace(/\{(\d)\}/g, (_, i) => `<b>${esc(vals[i])}</b>`); }
/* ============================================================
   State & Helfer
   ============================================================ */
const S = {
  lang: "de", theme: "system", data: null, viewId: "", panel: "home",
  editingId: null, pendingDel: null, pendingAct: null,
  calStart: null, calEnd: null, calMonth: null,
  offline: false, authMode: "login", installEvt: null, reportRange: "365", recovery: false, tz: ""
};
let backend = null, unsubscribe = null;

const $ = id => document.getElementById(id);
const T = () => TPROXY;
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const icon = (id, cls) => `<svg class="i ${cls || ""}"><use href="#${id}"/></svg>`;
const initial = s => (String(s || "?").trim()[0] || "?").toUpperCase();

/* ---------- Datum ---------- */
const toNum = iso => { const [y, m, d] = iso.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); };
const toIso = n => new Date(n * DAY).toISOString().slice(0, 10);
// "Heute" in der gewählten Zeitzone (leer = Zeitzone des Geräts)
function todayNum() {
  if (window.__TODAY_OVERRIDE) return toNum(window.__TODAY_OVERRIDE);
  const d = new Date();
  if (S.tz) {
    try {
      const p = new Intl.DateTimeFormat("en-CA", { timeZone: S.tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
      const g = t => +p.find(x => x.type === t).value;
      return Math.round(Date.UTC(g("year"), g("month") - 1, g("day")) / DAY);
    } catch (e) { /* unbekannte Zeitzone → Gerätezeit */ }
  }
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}
const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; } };
function tzOffset(tz) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date());
    return (p.find(x => x.type === "timeZoneName") || {}).value.replace("GMT", "UTC") || "";
  } catch (e) { return ""; }
}
function allTimeZones() {
  try { if (Intl.supportedValuesOf) return Intl.supportedValuesOf("timeZone"); } catch (e) {}
  return ["Europe/Berlin", "Europe/Vienna", "Europe/Zurich", "Europe/Tirane", "Europe/Belgrade", "Europe/Skopje", "Europe/Istanbul", "Europe/London", "Europe/Paris", "Europe/Rome", "Europe/Madrid", "Europe/Athens", "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata", "Asia/Shanghai", "Asia/Tokyo", "America/New_York", "America/Los_Angeles", "Australia/Sydney", "UTC"];
}
let tzListBuilt = false;
function renderTz() {
  const sel = $("tzSelect"), t = T(), dev = deviceTz();
  const autoLabel = t.tzAuto(dev ? `${dev.replace(/_/g, " ")} · ${tzOffset(dev)}` : "—");
  if (!tzListBuilt) {
    sel.innerHTML = `<option value="">${esc(autoLabel)}</option>` + allTimeZones()
      .map(z => `<option value="${esc(z)}">${esc(z.replace(/_/g, " "))} · ${esc(tzOffset(z))}</option>`).join("");
    tzListBuilt = true;
  } else sel.options[0].textContent = autoLabel;
  sel.value = S.tz;
}
const pad = x => String(x).padStart(2, "0");
// Datumsformate, Monats- und Wochentagsnamen kommen aus der Sprachdatei –
// so sieht es auf jedem Gerät gleich aus, egal welche Sprachdaten der Browser mitbringt.
function dparts(n) { const d = new Date(n * DAY); return { d: d.getUTCDate(), m: d.getUTCMonth(), y: d.getUTCFullYear(), wd: (d.getUTCDay() + 6) % 7 }; }
function fmt(n) {
  const p = dparts(n), L = D(), E = DICTS.en || {};
  return fillNamed(L.dateFmt || "{dd}.{mm}.{y}", { d: p.d, dd: pad(p.d), m: p.m + 1, mm: pad(p.m + 1), y: p.y, mon: (L.monthsShort || E.monthsShort)[p.m], month: (L.months || E.months)[p.m] });
}
const weekdayShort = n => (D().wd || DICTS.en.wd)[dparts(n).wd];
const fmtW = n => fillNamed(D().dateWdFmt || "{wd}, {date}", { wd: weekdayShort(n), date: fmt(n) });
function monthName(n, short) {
  const p = dparts(n), L = D(), E = DICTS.en || {};
  return short ? (L.monthsShort || E.monthsShort)[p.m] : fillNamed(L.monthYear || "{month} {y}", { month: (L.months || E.months)[p.m], y: p.y });
}

/* ---------- Länder ---------- */
let regionNames = null;
function countryName(code) {
  if (code === "XX" || !code) return T().other;
  const i = CODES.indexOf(code), L = D();
  if (L.countries && L.countries[code]) return L.countries[code];
  try {
    const loc = intlLoc();
    if (Intl.DisplayNames.supportedLocalesOf([loc]).length) {
      if (!regionNames || regionNames._loc !== loc) regionNames = Object.assign(new Intl.DisplayNames([loc], { type: "region" }), { _loc: loc });
      const name = regionNames.of(code);
      if (name && name !== code) return name;
    }
  } catch (e) {}
  return i >= 0 ? EN_NAMES[i] : code;
}
function fillCountrySelect(sel) {
  const prev = sel.value;
  const sorted = CODES.map(c => [c, countryName(c)]).sort((a, b) => a[1].localeCompare(b[1], intlLoc()));
  sel.innerHTML = sorted.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join("") + `<option value="XX">${esc(T().other)}</option>`;
  sel.value = prev && (CODES.includes(prev) || prev === "XX") ? prev : "DE";
}

/* ============================================================
   Daten-Zugriff
   ============================================================ */
const me = () => S.data && S.data.me;
const profiles = () => {
  if (!S.data) return [];
  const m = me();
  const rank = p => p.owner_id === m.id ? (p.is_self ? 0 : 1) : 2;
  return S.data.profiles.slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
};
const profileById = id => S.data && S.data.profiles.find(p => p.id === id);
const staysFor = pid => S.data ? S.data.stays.filter(s => s.profile_id === pid) : [];
const effEnd = s => s.end_date || toIso(Math.max(todayNum(), toNum(s.start_date)));
const viewName = () => { const p = profileById(S.viewId); return p ? p.name : ""; };

/* ============================================================
   90/180-Logik
   ============================================================ */
function daySet(pid, extra, excludeId) {
  const set = new Set();
  const list = staysFor(pid).filter(s => s.id !== excludeId).map(s => ({ start: s.start_date, end: effEnd(s) })).concat(extra || []);
  for (const r of list) {
    const a = toNum(r.start), b = Math.min(toNum(r.end), a + MAX_RANGE_DAYS);
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}
function usage(n, set) { let c = 0; for (let k = n - WINDOW + 1; k <= n; k++) if (set.has(k)) c++; return c; }
function firstOver(set, from, to) { for (let n = from; n <= to; n++) if (set.has(n) && usage(n, set) > LIMIT) return n; return null; }
function projectOver(set, from) { const s = new Set(set); for (let n = from; n < from + 400; n++) { s.add(n); if (usage(n, s) > LIMIT) return n; } return null; }
function nextEntry(set, from) { for (let n = from; n < from + 400; n++) { if (usage(n, set) + (set.has(n) ? 0 : 1) <= LIMIT) return n; } return null; }
function stayState(s, today) { const a = toNum(s.start_date); if (!s.end_date) return a > today ? "planned" : "current"; const b = toNum(s.end_date); return b < today ? "past" : a > today ? "planned" : "current"; }

function computeStatus(pid) {
  const today = todayNum();
  if (!pid) return { level: "none", today, set: new Set() };
  const set = daySet(pid);
  const used = usage(today, set);
  const remain = Math.max(0, LIMIT - used);
  const over = projectOver(set, today);
  const st = { today, set, used, remain, projOver: over, projLast: over - 1, maxStay: Math.max(0, over - today - (set.has(today) ? 1 : 0)) };
  if (over === today) st.projNext = nextEntry(set, today);
  let planned = null;
  for (const s of staysFor(pid)) {
    const a = toNum(s.start_date), b = toNum(effEnd(s));
    if (b < today || !s.end_date) continue;
    const v = firstOver(set, Math.max(a, today), b);
    if (v !== null && (!planned || v < planned.over)) planned = { over: v, last: v - 1, stay: s };
  }
  st.planned = planned;
  if (used > LIMIT) {
    let since = today; while (usage(since - 1, set) > LIMIT) since--;
    Object.assign(st, { level: "red", kind: "over", since, next: nextEntry(set, today + (set.has(today) ? 1 : 0)) });
  } else if (planned) Object.assign(st, { level: "red", kind: "planned" });
  else if (remain === 0) Object.assign(st, { level: "red", kind: set.has(today) ? "zeroIn" : "zeroOut", next: nextEntry(set, today + 1) });
  else if (remain <= SOON) Object.assign(st, { level: "orange", kind: "soon" });
  else Object.assign(st, { level: "green", kind: "ok" });
  return st;
}
function checkRange(pid, s, e, excludeId) {
  const set = daySet(pid, [{ start: s, end: e }], excludeId);
  const a = toNum(s), b = toNum(e);
  const v = firstOver(set, a, b);
  if (v === null) return { ok: true, rest: Math.max(0, LIMIT - usage(b, set)) };
  if (v === a) return { ok: false, blocked: true, next: nextEntry(daySet(pid, null, excludeId), a) };
  return { ok: false, last: v - 1, over: v, stay: v - a };
}
function validateRange(s, e, open) {
  if (!s || (!e && !open)) return open ? "eMissingStart" : "eMissing";
  if (open) e = toIso(Math.max(todayNum(), toNum(s)));
  if (!ISO_RE.test(s) || !ISO_RE.test(e)) return "eYear";
  const ys = +s.slice(0, 4), ye = +e.slice(0, 4);
  if (ys < 2000 || ys > 2100 || ye < 2000 || ye > 2100) return "eYear";
  if (e < s) return "eOrder";
  if (toNum(e) - toNum(s) + 1 > MAX_RANGE_DAYS) return "eRange";
  return null;
}

/* ============================================================
   UI-Helfer
   ============================================================ */
let toastTimer = null;
function toast(msg, kind) {
  const el = $("toast");
  el.className = "toast" + (kind === "warn" ? " warn" : "");
  el.textContent = msg;
  // kein requestAnimationFrame: läuft im Hintergrund nicht und ließe die Meldung sonst dauerhaft stehen
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), kind === "warn" ? 6000 : 3200);
}
function showErr(id, key, inputs, raw) {
  const el = $(id);
  const msg = raw || (key ? T()[key] : "");
  if (msg) { el.innerHTML = icon("i-alert", "sm") + `<span>${esc(msg)}</span>`; el.classList.add("show"); }
  else { el.innerHTML = ""; el.classList.remove("show"); }
  (inputs || []).forEach(i => $(i).setAttribute("aria-invalid", msg ? "true" : "false"));
}
const errText = e => T()[{ exists: "eExists", invalid: "eInvalid", unconfirmed: "eUnconfirmed", weak: "eWeak", forbidden: "eForbidden", network: "eNetwork" }[e && e.code] || "eUnknown"];

// Führt eine Schreibaktion aus, lädt danach neu und meldet Erfolg/Fehler
async function act(fn, okMsg, btn) {
  if (S.offline) { toast(T().offline, "warn"); return false; }
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    await refresh();
    if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg);
    return r === undefined ? true : r;
  } catch (e) {
    console.warn(e);
    toast(errText(e), "warn");
    return false;
  } finally { if (btn) btn.disabled = false; }
}

/* ============================================================
   Start, Login, Account-Wechsel
   ============================================================ */
async function boot() {
  S.lang = detectLang();
  await loadLang("en");
  if (S.lang !== "en") await loadLang(S.lang);
  if (!DICTS[S.lang]) S.lang = "en";
  fillLangSelects();
  S.theme = ["light", "dark", "system"].includes(lsGet("s9_theme")) ? lsGet("s9_theme") : "system";
  S.reportRange = lsGet("s9_report_range") || "365";
  S.tz = lsGet("s9_tz") || "";
  if (S.tz && !allTimeZones().includes(S.tz)) S.tz = "";
  applyTheme();
  backend = createBackend();
  [$("fCountry"), $("cCountry")].forEach(fillCountrySelect);
  let redirect = null;
  try { redirect = await backend.handleRedirect(); } catch (e) { console.warn(e); }
  let who = null;
  try { who = await backend.restore(); } catch (e) { console.warn(e); }
  $("boot").hidden = true;
  if (who) await enterApp();
  else showAuth("login");
  if (redirect === "recovery") { S.recovery = true; switchPanel("settings"); toast(T().setNewPw, "warn"); $("newPw").focus(); }
  registerSW();
}

function showAuth(mode) {
  $("shell").hidden = true; $("accLayer").hidden = true;
  $("auth").hidden = false;
  $("aBack").hidden = !backend.activeId() || !S.data;
  $("demoNote").hidden = backend.mode !== "demo";
  setAuthMode(mode || "login");
  renderAuthTexts();
  setTimeout(() => $(S.authMode === "signup" ? "aName" : "aEmail").focus(), 50);
}
function setAuthMode(mode) {
  S.authMode = mode;
  $("aNameField").hidden = mode !== "signup";
  $("aPwField").hidden = mode === "reset";
  $("aPw").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("authTabs").hidden = mode === "reset";
  $("aNotice").innerHTML = "";
  showErr("aErr", null, ["aName", "aEmail", "aPw"]);
  renderAuthTexts();
}
function renderAuthTexts() {
  const t = T();
  renderI18n();
  document.querySelectorAll("#authTabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === S.authMode)));
  $("authLangSel").value = S.lang;
  $("aSubmit").textContent = S.authMode === "signup" ? t.signupBtn : S.authMode === "reset" ? t.resetBtn : t.loginBtn;
  $("aForgot").textContent = S.authMode === "reset" ? t.backToLogin : t.forgot;
  $("aPw").placeholder = S.authMode === "signup" ? t.pwHint : "";
}
async function onAuthSubmit(e) {
  e.preventDefault();
  const t = T(), mode = S.authMode;
  const name = $("aName").value.trim(), email = $("aEmail").value.trim(), pw = $("aPw").value;
  $("aNotice").innerHTML = "";
  if (mode === "signup" && !name) return showErr("aErr", "eName", ["aName"]);
  if (!EMAIL_RE.test(email)) return showErr("aErr", "eEmail", ["aEmail"]);
  if (mode !== "reset" && pw.length < (mode === "signup" ? 8 : 1)) return showErr("aErr", "eWeak", ["aPw"]);
  showErr("aErr", null, ["aName", "aEmail", "aPw"]);
  const btn = $("aSubmit"); btn.disabled = true;
  try {
    if (mode === "reset") {
      const r = await backend.resetPassword(email);
      $("aNotice").innerHTML = `<div class="notice lvl-blue">${esc(r && r.demo ? t.resetDemo : t.resetSent(email))}</div>`;
      return;
    }
    const r = mode === "signup" ? await backend.signUp(name, email, pw) : await backend.signIn(email, pw);
    if (r && r.confirm) { $("aNotice").innerHTML = `<div class="notice lvl-green">${esc(t.confirmSent(email))}</div>`; return; }
    $("authForm").reset();
    S.viewId = "";
    await enterApp();
  } catch (err) {
    showErr("aErr", null, null, errText(err));
  } finally { btn.disabled = false; }
}

async function enterApp() {
  $("auth").hidden = true; $("shell").hidden = false;
  if (unsubscribe) unsubscribe();
  unsubscribe = backend.subscribe(debounce(() => refresh(), 200));
  S.calStart = S.calEnd = null; S.editingId = null; S.pendingDel = null;
  if (!S.panel) S.panel = "home";
  switchPanel(S.panel);
  await refresh();
  cancelEdit();
}
function cacheKey() { return "s9_cache_" + backend.activeId(); }
async function refresh() {
  try {
    S.data = await backend.loadAll();
    S.offline = false;
    lsSet(cacheKey(), JSON.stringify(S.data));
  } catch (e) {
    if (e && e.code === "network") {
      try { S.data = JSON.parse(lsGet(cacheKey())); } catch (x) { S.data = null; }
      S.offline = true;
      if (!S.data) { S.data = { me: { id: backend.activeId(), email: "", name: "" }, profiles: [], members: [], invites: [], stays: [] }; }
    } else if (e && e.code === "invalid") {
      toast(T().sessionExpired, "warn"); S.data = null; showAuth("login"); return;
    } else { console.warn(e); toast(errText(e), "warn"); return; }
  }
  // Absicherung: nur gültige Datumswerte verwenden, damit fehlerhafte Daten nie die Anzeige zerschießen
  if (S.data && Array.isArray(S.data.stays)) {
    const d = v => v ? String(v).slice(0, 10) : null;
    S.data.stays = S.data.stays.map(s => ({ ...s, start_date: d(s.start_date), end_date: d(s.end_date) }))
      .filter(s => ISO_RE.test(s.start_date) && (s.end_date === null || ISO_RE.test(s.end_date)) && !isNaN(toNum(s.start_date)));
  }
  const ps = profiles();
  if (!ps.some(p => p.id === S.viewId)) {
    const saved = lsGet("s9_view_" + backend.activeId());
    S.viewId = ps.some(p => p.id === saved) ? saved : (ps[0] ? ps[0].id : "");
  }
  renderAll();
}
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

function openAccounts() {
  const t = T(), accs = backend.accounts(), active = backend.activeId();
  $("accList").innerHTML = accs.map(a => `
    <button class="acc" data-acc="${esc(a.id)}">
      <span class="avatar sm ${a.id === active ? "" : "alt"}">${esc(initial(a.name))}</span>
      <span class="who"><b>${esc(a.name)}</b><span>${esc(a.email)}</span></span>
      ${a.id === active ? `<span class="tick">${icon("i-tick")}</span>` : ""}
    </button>`).join("") +
    `<div class="divider" style="margin:8px 0"></div>
    <button class="acc add" data-acc-add><span class="avatar sm">${icon("i-plus", "sm")}</span><span class="who"><b>${esc(t.addAccount)}</b></span></button>
    <button class="acc danger" data-acc-out>${icon("i-logout")}<span class="who"><b>${esc(t.signOut)}</b><span>${esc((accs.find(a => a.id === active) || {}).email || "")}</span></span></button>`;
  $("accLayer").hidden = false;
  const first = $("accList").querySelector(".acc"); if (first) first.focus();
}
function closeAccounts() { $("accLayer").hidden = true; }
async function switchAccount(id) {
  closeAccounts();
  if (id === backend.activeId()) return;
  const who = await backend.switchTo(id);
  S.viewId = ""; S.data = null;
  if (!who) { toast(T().sessionExpired, "warn"); showAuth("login"); return; }
  await enterApp();
  toast(T().switchedTo(who.name || who.email));
}
async function signOut() {
  closeAccounts();
  await backend.signOut();
  S.data = null; S.viewId = "";
  const rest = backend.accounts();
  if (rest.length) { await switchAccount(rest[0].id); }
  else { showAuth("login"); toast(T().signedOut); }
}

/* ============================================================
   Rendering
   ============================================================ */
function renderI18n() {
  const t = T();
  document.documentElement.lang = S.lang;
  document.documentElement.dir = RTL.has(S.lang) ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach(el => { const v = t[el.dataset.i18n]; if (typeof v === "string") el.textContent = v; });
}
function switchPanel(name) {
  S.panel = name;
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + name));
  document.querySelectorAll(".nav-btn").forEach(b => { if (b.dataset.panel === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  if (S.data) renderChrome();
  if (name === "calendar" && S.data) renderCalendar();
  window.scrollTo({ top: 0 });
}
function renderAll() {
  if (!S.data) return;
  renderChrome(); renderProfiles(); renderHome(); renderTrips(); renderCalendar(); renderSettings();
}
function renderChrome() {
  const t = T();
  renderI18n();
  const titles = { home: t.navHome, trips: t.navTrips, calendar: t.navCalendar, settings: t.navSettings };
  $("pageTitle").textContent = titles[S.panel];
  $("pageSub").textContent = t.todayIs(fmtW(todayNum()));
  const m = me();
  $("accBtn").textContent = initial(m && m.name);
  $("accBtn").setAttribute("aria-label", `${t.accountsTitle}: ${m ? m.name : ""}`);
  $("demoPill").hidden = backend.mode !== "demo";
  $("offlineBar").hidden = !S.offline;
  $("formTitle").textContent = S.editingId ? t.formEdit : t.formAdd;
  $("fSubmit").textContent = S.editingId ? t.saveChanges : t.add;
  $("fCancel").hidden = !S.editingId;
  $("aboutText").innerHTML = t.about;
  $("newPersonName").placeholder = t.addPersonPh;
  const lvl = S.offline ? "lvl-orange" : backend.mode === "cloud" ? "lvl-green" : "lvl-none";
  const txt = S.offline ? t.syncOffline : backend.mode === "cloud" ? t.syncCloud : t.syncDemo;
  [$("syncChip"), $("navSync")].forEach(el => { el.className = "status-chip " + lvl; el.textContent = txt; });
  $("syncHint").textContent = backend.mode === "cloud" ? t.syncCloudHint : t.syncDemoHint;
  $("navSyncHint").textContent = backend.mode === "cloud" ? t.navHintCloud : t.navHintDemo;
  const legend = (extra) => `<span><i class="sw stay"></i>${esc(t.legStay)}</span><span><i class="sw plan"></i>${esc(t.legPlan)}</span><span><i class="sw reached"></i>${esc(t.legReached)}</span><span><i class="sw over"></i>${esc(t.legOver)}</span>${extra}`;
  $("homeLegend").innerHTML = legend(`<span><i class="sw win"></i>${esc(t.legWindow)}</span>`);
  $("calLegend").innerHTML = legend(`<span><i class="sw today"></i>${esc(t.today)}</span>`);
}
function profileOptions(sel, value) {
  sel.innerHTML = profiles().map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  sel.value = profiles().some(p => p.id === value) ? value : S.viewId;
}
function renderProfiles() {
  const ps = profiles();
  const sel = $("viewProfile");
  profileOptions(sel, S.viewId);
  sel.disabled = ps.length < 2;
  if (!S.editingId) profileOptions($("fProfile"), $("fProfile").value || S.viewId);
  profileOptions($("cProfile"), $("cProfile").value || S.viewId);
}

function renderHome() {
  const t = T();
  const st = computeStatus(S.viewId);
  $("heroCard").className = "card span-2 lvl-" + st.level;
  const C = 2 * Math.PI * 52;
  const banner = $("banner");
  if (st.level === "none") {
    $("gNum").textContent = "90"; $("gaugeVal").setAttribute("stroke-dasharray", `0 ${C}`);
    banner.innerHTML = ""; ["sUsed", "sRemain", "sMax"].forEach(i => $(i).textContent = "–");
    $("keydates").innerHTML = ""; $("keydatesCap").textContent = "";
  } else {
    $("gNum").textContent = st.remain;
    $("gaugeVal").setAttribute("stroke-dasharray", `${Math.min(1, st.used / LIMIT) * C} ${C}`);
    // Bei 0 Tagen nichts zeichnen (sonst erscheint wegen der runden Linienenden ein Punkt)
    $("gaugeVal").style.opacity = st.used > 0 ? "1" : "0";
    const msg = {
      over: () => t.bOver(fmt(st.since), st.used, fmt(st.next)),
      planned: () => t.bPlanned(fmt(st.planned.last), fmt(st.planned.over)),
      zeroIn: () => t.bZeroIn(fmt(st.next)), zeroOut: () => t.bZeroOut(fmt(st.next)),
      soon: () => t.bSoon(t.days(st.remain)), ok: () => t.bOk(st.remain)
    }[st.kind]();
    banner.innerHTML = icon(st.level === "green" ? "i-check" : "i-alert") + `<span>${esc(msg)}</span>`;
    $("sUsed").innerHTML = `${st.used}<small> / 90</small>`;
    $("sRemain").textContent = st.remain;
    $("sMax").innerHTML = `${st.maxStay}<small> ${esc(t.dayUnit(st.maxStay))}</small>`;
    const kd = (cls, k, v, s) => `<div class="keydate ${cls}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;
    if (st.kind === "planned") {
      const p = st.planned, s = p.stay;
      $("keydates").innerHTML = kd("reached", t.kdLast, fmtW(p.last), t.kdLastSub) + kd("over", t.kdOver, fmtW(p.over), t.kdOverSub);
      $("keydatesCap").textContent = t.kdCapPlanned(countryName(s.country), fmt(toNum(s.start_date)), fmt(toNum(s.end_date)));
    } else if (st.projOver === st.today) {
      $("keydates").innerHTML = kd("next", t.kdNext, fmtW(st.projNext), t.kdNextSub);
      $("keydatesCap").textContent = "";
    } else {
      $("keydates").innerHTML = kd("reached", t.kdLast, fmtW(st.projLast), t.kdLastSub) + kd("over", t.kdOver, fmtW(st.projOver), t.kdOverSub);
      $("keydatesCap").textContent = t.kdCap;
    }
  }
  $("timeline").innerHTML = timelineHtml(st);
  const up = staysFor(S.viewId).filter(s => toNum(effEnd(s)) >= st.today).sort((a, b) => a.start_date.localeCompare(b.start_date));
  $("upcoming").innerHTML = up.length ? up.map(s => stayHtml(s, st.set, st.today, false)).join("") : `<div class="empty">${icon("i-cal")}${esc(t.upEmpty)}</div>`;
  renderQuick(st);
}

function renderQuick(st) {
  const t = T(), card = $("quickCard");
  if (!S.viewId) { card.hidden = true; return; }
  card.hidden = false;
  const open = staysFor(S.viewId).find(s => !s.end_date && toNum(s.start_date) <= st.today);
  if (open) {
    const n = st.today - toNum(open.start_date) + 1;
    card.innerHTML = `<div class="quick lvl-blue">
      <div class="q-icon">${icon("i-plane-in")}</div>
      <div class="q-text"><div class="q-title"><span class="live-dot"></span>${esc(t.qInTitle(countryName(open.country)))}</div><div class="q-sub">${esc(t.qInSub(fmt(toNum(open.start_date)), n))}</div></div>
      <div class="q-actions"><button class="btn btn-primary" id="qOut">${icon("i-plane-out", "sm")}${esc(t.qOutBtn)}</button><button class="btn btn-secondary" id="qEdit">${esc(t.qEdit)}</button></div>
    </div>`;
    $("qOut").onclick = e => act(() => backend.upsertStay({ ...open, end_date: toIso(st.today) }), t.qOutDone, e.currentTarget);
    $("qEdit").onclick = () => startEdit(open.id);
  } else {
    const prev = $("qCountry") ? $("qCountry").value : "";
    card.innerHTML = `<div class="quick lvl-blue">
      <div class="q-icon">${icon("i-plane-in")}</div>
      <div class="q-text"><div class="q-title">${esc(t.qEnterTitle)}</div><div class="q-sub">${esc(t.qEnterSub)}</div></div>
      <div class="q-actions"><select id="qCountry" aria-label="${esc(t.country)}"></select><button class="btn btn-primary" id="qIn">${esc(t.qEnterBtn)}</button></div>
    </div>`;
    fillCountrySelect($("qCountry"));
    if (prev) $("qCountry").value = prev;
    $("qIn").onclick = e => {
      const todayIso = toIso(st.today);
      if (staysFor(S.viewId).some(s => s.start_date <= todayIso && effEnd(s) >= todayIso)) { toast(t.qCovered, "warn"); return; }
      act(() => backend.upsertStay({ profile_id: S.viewId, country: $("qCountry").value, start_date: todayIso, end_date: null }), t.qEnterDone, e.currentTarget);
    };
  }
}

function timelineHtml(st, forPrint) {
  const t = T();
  const today = st.today, from = today - WINDOW + 1;
  const lastEnd = Math.max(0, ...staysFor(S.viewId).map(s => toNum(effEnd(s))));
  const to = Math.max(today + 120, Math.min(today + 365, lastEnd + 14)), W = to - from + 1;
  const set = st.set || new Set();
  let rects = `<rect class="win" x="0" y="0" width="${WINDOW}" height="46"/>`;
  for (let n = from; n <= to; n++) {
    let cls = "d";
    if (set.has(n)) { const u = usage(n, set); cls += u > LIMIT ? " over" : u === LIMIT ? " reached" : n <= today ? " stay" : " plan"; }
    rects += `<rect class="${cls}" x="${n - from + 0.12}" y="8" width="0.76" height="30"/>`;
  }
  rects += `<line class="today" x1="${WINDOW - 0.5}" x2="${WINDOW - 0.5}" y1="0" y2="46"/>`;
  let months = "";
  const sd = new Date(from * DAY);
  let y = sd.getUTCFullYear(), m = sd.getUTCMonth() + 1;
  const step = W > 400 ? 2 : 1;
  // Monatsanfänge sammeln; jedes Label bekommt genau den Platz bis zum nächsten (kein Überlappen)
  const starts = [];
  for (let i = 0; i < 24; i++) {
    const n = Math.round(Date.UTC(y, m, 1) / DAY);
    if (n > to) break;
    if (i % step === 0) starts.push(n);
    m++; if (m > 11) { m = 0; y++; }
  }
  starts.forEach((n, i) => {
    const pct = (n - from) / W * 100;
    const end = i + 1 < starts.length ? (starts[i + 1] - from) / W * 100 : 100;
    if (end - pct < 6.5) return; // zu wenig Platz (z. B. angeschnittener Monat am Rand) → weglassen
    months += `<span style="left:${pct}%;width:${end - pct}%">${esc(monthName(n, true))}</span>`;
  });
  return `<div class="tl-today" style="left:${(WINDOW - 0.5) / W * 100}%">${esc(t.today)}</div>` +
    `<svg viewBox="0 0 ${W} 46" preserveAspectRatio="none" role="img" aria-label="${esc(t.tlTitle)}">${rects}</svg>` +
    `<div class="tl-months notranslate" translate="no">${months}</div>`;
}

function stayHtml(s, set, today, withActions) {
  const t = T();
  const a = toNum(s.start_date), b = toNum(effEnd(s));
  const state = stayState(s, today);
  const v = firstOver(set, a, b);
  const pillTxt = { past: t.stPast, current: t.stCurrent, planned: t.stPlanned }[state];
  let actions = "";
  if (withActions) {
    actions = S.pendingDel === s.id
      ? `<div class="confirm"><span>${esc(t.delAsk)}</span><button class="btn btn-danger btn-sm" data-act="del-yes" data-id="${esc(s.id)}">${esc(t.del)}</button><button class="btn btn-secondary btn-sm" data-act="del-no">${esc(t.cancel)}</button></div>`
      : `<button class="icon-btn" data-act="edit" data-id="${esc(s.id)}" aria-label="${esc(t.edit)}" title="${esc(t.edit)}">${icon("i-edit")}</button><button class="icon-btn danger" data-act="del" data-id="${esc(s.id)}" aria-label="${esc(t.del)}" title="${esc(t.del)}">${icon("i-trash")}</button>`;
  }
  const endTxt = s.end_date ? fmt(b) : `<span style="color:var(--accent);font-weight:650">${esc(t.ongoing)}</span>`;
  return `<div class="trip${v !== null ? " flag" : ""}">
    <div class="trip-main">
      <div class="trip-top"><span class="cc">${esc(s.country === "XX" ? "··" : s.country)}</span><span class="trip-country">${esc(countryName(s.country))}</span><span class="pill ${state}">${esc(pillTxt)}</span></div>
      <div class="trip-dates">${esc(fmt(a))} – ${endTxt} <span class="n">· ${esc(t.days(b - a + 1))}</span></div>
      <div class="trip-check ${v === null ? "ok" : "bad"}">${icon(v === null ? "i-check" : "i-alert", "sm")}<span>${esc(v === null ? t.tOk : t.tFail(fmt(v - 1), fmt(v)))}</span></div>
    </div>
    ${withActions ? `<div class="trip-actions">${actions}</div>` : ""}
  </div>`;
}

function renderTrips() {
  const t = T(), today = todayNum();
  const list = staysFor(S.viewId).slice().sort((a, b) => b.start_date.localeCompare(a.start_date));
  $("listCount").textContent = t.listCount(list.length, viewName());
  const set = daySet(S.viewId);
  $("tripList").innerHTML = list.length ? list.map(s => stayHtml(s, set, today, true)).join("") : `<div class="empty">${icon("i-list")}${esc(t.listEmpty)}</div>`;
  updateFormPreview();
}
function updateFormPreview() {
  const s = $("fStart").value, open = $("fOpen").checked, e = open ? (s ? toIso(Math.max(todayNum(), toNum(s))) : "") : $("fEnd").value, pid = $("fProfile").value;
  if (!s || !e || !pid || validateRange(s, e, false)) { $("fPreview").innerHTML = ""; return; }
  $("fPreview").innerHTML = resultHtml(checkRange(pid, s, e, S.editingId), s);
}
function resultHtml(r, startIso) {
  const t = T();
  const dot = c => `<span class="dot" style="background:var(--${c}-fill)"></span>`;
  if (r.ok) return `<div class="result lvl-green"><strong>${esc(t.rFitsTitle)}</strong> ${esc(t.rFitsText(t.days(r.rest)))}</div>`;
  if (r.blocked) return `<div class="result lvl-red"><strong>${esc(t.rBlockedTitle(fmtW(toNum(startIso))))}</strong> ${esc(t.rBlockedText)}<div class="rows"><div>${dot("green")}${boldFill("rBlockedNext", fmtW(r.next))}</div></div></div>`;
  return `<div class="result lvl-red"><strong>${esc(t.rFailTitle)}</strong><div class="rows"><div>${dot("orange")}${boldFill("rFailLast", fmtW(r.last))}</div><div>${dot("red")}${boldFill("rFailOver", fmtW(r.over))}</div><div>${esc(t.rFailStay(t.days(r.stay)))}</div></div></div>`;
}

/* ---------- Kalender ---------- */
const monthsToShow = () => window.matchMedia("(min-width: 1100px)").matches ? 2 : 1;
function renderCalendar() {
  const t = T();
  if (!S.calMonth) { const d = new Date(todayNum() * DAY); S.calMonth = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; }
  const today = todayNum(), set = daySet(S.viewId);
  const dows = D().wdMin || DICTS.en.wdMin;
  const s = S.calStart, e = S.calEnd;
  let html = "";
  for (let k = 0; k < monthsToShow(); k++) {
    const y = S.calMonth.y + Math.floor((S.calMonth.m + k) / 12), m = (S.calMonth.m + k) % 12;
    const first = Math.round(Date.UTC(y, m, 1) / DAY), dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const offset = (new Date(first * DAY).getUTCDay() + 6) % 7;
    let cells = dows.map(d => `<div class="dow">${esc(d)}</div>`).join("");
    for (let i = 0; i < offset; i++) cells += `<div class="day blank"></div>`;
    for (let d = 1; d <= dim; d++) {
      const n = first + d - 1;
      let cls = "day", tip = fmtW(n);
      if (set.has(n)) { const u = usage(n, set); cls += u > LIMIT ? " over" : u === LIMIT ? " reached" : n <= today ? " stay" : " plan"; tip = t.dayTip(fmtW(n), u); }
      if (n === today) cls += " today";
      if (s !== null && (n === s || n === e)) cls += " sel";
      else if (s !== null && e !== null && n > s && n < e) cls += " sel-mid";
      cells += `<button class="${cls}" data-n="${n}" title="${esc(tip)}" aria-label="${esc(tip)}">${d}</button>`;
    }
    html += `<div><div class="month-label">${esc(monthName(first, false))}</div><div class="cal-grid">${cells}</div></div>`;
  }
  $("months").innerHTML = html;
  $("calHintText").textContent = s !== null && e === null ? t.calPickEnd(fmt(s)) : s !== null ? t.calPicked : t.calPickStart;
  if (s !== null && e !== null) {
    $("selCard").hidden = false;
    $("selRange").textContent = `${fmt(s)} – ${fmt(e)}`;
    $("selDays").textContent = t.selDays(e - s + 1);
    updateSelPreview();
  } else $("selCard").hidden = true;
}
function updateSelPreview() {
  const pid = $("cProfile").value;
  if (!pid || S.calStart === null || S.calEnd === null) { $("selPreview").innerHTML = ""; return; }
  const si = toIso(S.calStart);
  $("selPreview").innerHTML = resultHtml(checkRange(pid, si, toIso(S.calEnd)), si);
}

/* ---------- Einstellungen ---------- */
function renderSettings() {
  const t = T(), m = me();
  $("langSelect").value = S.lang;
  document.querySelectorAll("#themeSeg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.themeVal === S.theme)));
  if (document.activeElement !== $("myName")) $("myName").value = m.name || "";
  $("accEmail").textContent = m.email || "";
  renderPeople();
  renderInstall();
  renderTz();
}
function renderPeople() {
  const t = T(), m = me();
  const rows = profiles().map(p => {
    const own = p.owner_id === m.id;
    const members = S.data.members.filter(x => x.profile_id === p.id && x.user_id !== m.id);
    const invites = S.data.invites.filter(x => x.profile_id === p.id);
    const sub = own ? (p.is_self ? t.yourProfile : t.managedProfile) : t.sharedBy(p.owner_email);
    const ask = S.pendingAct;
    let head = `<div class="prof-head"><span class="avatar sm ${p.is_self && own ? "" : "alt"}">${esc(initial(p.name))}</span><div class="who"><b>${esc(p.name)}${p.is_self && own ? ` <span class="pill person" style="vertical-align:1px">${esc(t.you)}</span>` : ""}</b><span>${esc(sub)}</span></div>`;
    head += `<button class="icon-btn" data-rename="${esc(p.id)}" aria-label="${esc(t.rename)}" title="${esc(t.rename)}">${icon("i-edit")}</button>`;
    if (own && !p.is_self) head += `<button class="icon-btn danger" data-delprof="${esc(p.id)}" aria-label="${esc(t.deleteProfile)}" title="${esc(t.deleteProfile)}">${icon("i-trash")}</button>`;
    if (!own) head += `<button class="btn btn-ghost-danger btn-sm" data-leave="${esc(p.id)}">${esc(t.leave)}</button>`;
    head += `</div>`;
    if (ask && ask.pid === p.id && (ask.kind === "delprof" || ask.kind === "leave")) head += `<div class="confirm" style="justify-content:flex-start"><span>${esc(ask.kind === "leave" ? t.leaveAsk : t.delProfileAsk)}</span><button class="btn btn-danger btn-sm" data-pa="yes">${esc(ask.kind === "leave" ? t.leave : t.del)}</button><button class="btn btn-secondary btn-sm" data-pa="no">${esc(t.cancel)}</button></div>`;
    if (ask && ask.pid === p.id && ask.kind === "rename") head += `<form class="inline-form" data-renameform="${esc(p.id)}"><input value="${esc(p.name)}" maxlength="40" required><button class="btn btn-primary btn-sm" type="submit">${esc(t.save)}</button><button class="btn btn-secondary btn-sm" type="button" data-pa="no">${esc(t.cancel)}</button></form>`;
    let body = "";
    if (own) {
      const list = members.map(x => `<div class="member"><span class="avatar sm alt">${esc(initial(x.email))}</span><span class="em">${esc(x.email)}</span>${ask && ask.kind === "rm" && ask.pid === p.id && ask.uid === x.user_id
        ? `<button class="btn btn-danger btn-sm" data-pa="yes">${esc(t.remove)}</button><button class="btn btn-secondary btn-sm" data-pa="no">${esc(t.cancel)}</button>`
        : `<button class="btn btn-ghost-danger btn-sm" data-rm="${esc(p.id)}" data-uid="${esc(x.user_id)}">${esc(t.remove)}</button>`}</div>`).join("") +
        invites.map(x => `<div class="member"><span class="avatar sm alt">${esc(initial(x.email))}</span><span class="em">${esc(x.email)}</span><span class="pill warn">${esc(t.pending)}</span><button class="icon-btn danger" data-uninv="${esc(p.id)}" data-email="${esc(x.email)}" aria-label="${esc(t.remove)}">${icon("i-x", "sm")}</button></div>`).join("");
      body = `<div class="sub-label">${esc(t.access)}</div>${list || `<div class="hint" style="margin:0">${esc(t.noAccess)}</div>`}
        <form class="inline-form" data-share="${esc(p.id)}"><input type="email" inputmode="email" autocapitalize="off" placeholder="${esc(t.invitePh)}" required><button class="btn btn-secondary" type="submit">${icon("i-share", "sm")}${esc(t.inviteBtn)}</button></form>`;
    }
    return `<div class="prof">${head}${body}</div>`;
  });
  $("peopleList").innerHTML = rows.join("");
}
function renderInstall() {
  const t = T(), box = $("installBody");
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (standalone) box.innerHTML = `<div class="notice lvl-green">${icon("i-check", "sm")} ${esc(t.installDone)}</div>`;
  else if (S.installEvt) box.innerHTML = `<button class="btn btn-primary" id="installBtn">${icon("i-phone", "sm")}${esc(t.installBtn)}</button>`;
  else box.innerHTML = `<ol class="steps">${(ios ? t.installIos : t.installOther).map(x => `<li>${x}</li>`).join("")}</ol>`;
  const b = $("installBtn");
  if (b) b.onclick = async () => { S.installEvt.prompt(); try { await S.installEvt.userChoice; } catch (e) {} S.installEvt = null; renderInstall(); };
}
function fillLangSelects() {
  const opts = LANGS.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join("");
  ["langSelect", "authLangSel"].forEach(id => { $(id).innerHTML = opts; $(id).value = S.lang; });
}
function applyTheme() {
  if (S.theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", S.theme);
}
async function setLang(l) {
  await loadLang(l);
  if (!DICTS[l]) return;
  S.lang = l; lsSet("s9_lang", l);
  [$("fCountry"), $("cCountry")].forEach(fillCountrySelect);
  if (!$("auth").hidden) renderAuthTexts();
  renderAll();
  if (!$("report").hidden) renderReport();
}

/* ============================================================
   Bericht
   ============================================================ */
function openReport() {
  const t = T();
  $("reportRange").innerHTML = [["180", t.r180], ["365", t.r365], ["all", t.rAll]].map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
  $("reportRange").value = S.reportRange;
  $("report").hidden = false;
  document.body.style.overflow = "hidden";
  renderReport();
}
function closeReport() { $("report").hidden = true; document.body.style.overflow = ""; }
function renderReport() {
  const t = T(), pid = S.viewId, p = profileById(pid);
  if (!p) return;
  renderI18n();
  const st = computeStatus(pid), today = st.today;
  const from = S.reportRange === "180" ? today - WINDOW + 1 : S.reportRange === "365" ? today - 364 : -Infinity;
  const list = staysFor(pid).filter(s => toNum(effEnd(s)) >= from).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const set = st.set;
  let total = 0;
  const rows = list.map((s, i) => {
    const a = toNum(s.start_date), b = toNum(effEnd(s));
    total += Math.max(0, b - a + 1);
    const v = firstOver(set, a, b);
    const win = usage(b, set);
    return `<tr><td>${i + 1}</td><td><b>${esc(countryName(s.country))}</b></td><td>${esc(fmt(a))}</td><td>${s.end_date ? esc(fmt(b)) : esc(t.ongoing)}</td><td class="num">${b - a + 1}</td><td class="num hide-sm">${win} / 90</td><td>${v === null ? `<span class="p-ok">✓ ${esc(t.rOk)}</span>` : `<span class="p-bad">✗ ${esc(t.rBad(fmt(v)))}</span>`}</td></tr>`;
  }).join("");
  const statusCls = { green: "g", orange: "o", red: "r" }[st.level] || "g";
  const bannerTxt = $("banner").textContent;
  const lastBox = st.projOver === today
    ? `<div class="p-box"><div class="k">${esc(t.rNext)}</div><div class="v">${esc(fmt(st.projNext))}</div><div class="s">${esc(weekdayShort(st.projNext))}</div></div>`
    : `<div class="p-box"><div class="k">${esc(t.rLast)}</div><div class="v">${esc(fmt(st.projLast))}</div><div class="s">${esc(t.rLastSub)}</div></div>`;
  const rangeLabel = { "180": t.r180, "365": t.r365, all: t.rAll }[S.reportRange];
  $("paper").innerHTML = `
    <div class="p-head">
      <span class="mark">${icon("i-globe")}</span>
      <div><h2>${esc(t.rDoc)}</h2><div class="meta">${esc(t.rFor)}: <b class="notranslate" translate="no" style="color:var(--p-text)">${esc(p.name)}</b> · ${esc(t.rPeriod)}: ${esc(rangeLabel)}</div></div>
      <div class="right">${esc(t.rCreated)}<br><b style="color:var(--p-text)">${esc(fmtW(today))}</b></div>
    </div>
    <div class="p-person">
      <div class="p-box"><div class="k">${esc(t.rUsed)}</div><div class="v">${st.used} / 90</div><div class="s">${esc(t.statUsed)}</div></div>
      <div class="p-box"><div class="k">${esc(t.rFree)}</div><div class="v">${st.remain}</div><div class="s">${esc(t.statRemain)}</div></div>
      ${lastBox}
    </div>
    <div class="p-status ${statusCls}">${esc(bannerTxt)}</div>
    <div class="p-section">${esc(t.tlTitle)}</div>
    <div class="p-tl"><div class="tl-wrap"><div class="tl">${timelineHtml(st)}</div></div>
      <div class="legend"><span><i class="sw stay"></i>${esc(t.legStay)}</span><span><i class="sw plan"></i>${esc(t.legPlan)}</span><span><i class="sw reached"></i>${esc(t.legReached)}</span><span><i class="sw over"></i>${esc(t.legOver)}</span><span><i class="sw win"></i>${esc(t.legWindow)}</span></div></div>
    <div class="p-section">${esc(t.navTrips)} · ${esc(t.rTotalSub(list.length))}</div>
    ${list.length ? `<table class="p-table">
      <thead><tr><th>${esc(t.rColNo)}</th><th>${esc(t.rColCountry)}</th><th>${esc(t.rColEntry)}</th><th>${esc(t.rColExit)}</th><th class="num">${esc(t.rColDays)}</th><th class="num hide-sm">${esc(t.rColWin)}</th><th>${esc(t.rColCheck)}</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td></td><td>${esc(t.rSum)}</td><td></td><td></td><td class="num">${total}</td><td class="hide-sm"></td><td></td></tr></tfoot>
    </table><p style="font-size:11.5px;color:var(--p-muted);margin:8px 0 0">${esc(t.rWinNote)}</p>` : `<div class="p-empty">${esc(t.rEmpty)}</div>`}
    <div class="p-foot"><span>${esc(t.rDisclaimer)}</span><span style="white-space:nowrap">${esc(t.rPage)}</span></div>`;
}

/* ============================================================
   Formulare & Aktionen
   ============================================================ */
function cancelEdit() {
  S.editingId = null;
  $("tripForm").reset();
  $("fEnd").disabled = false;
  $("fEnd").min = "2000-01-01";
  profileOptions($("fProfile"), S.viewId);
  showErr("fDateErr", null, ["fStart", "fEnd"]);
  $("fPreview").innerHTML = "";
  if (S.data) renderChrome();
}
function startEdit(id) {
  const s = S.data.stays.find(x => x.id === id); if (!s) return;
  S.editingId = id; S.pendingDel = null;
  switchPanel("trips");
  profileOptions($("fProfile"), s.profile_id);
  $("fCountry").value = s.country; $("fStart").value = s.start_date;
  $("fOpen").checked = !s.end_date; $("fEnd").disabled = !s.end_date; $("fEnd").value = s.end_date || "";
  $("fEnd").min = s.start_date;
  showErr("fDateErr", null, ["fStart", "fEnd"]);
  renderChrome(); renderTrips();
  $("formCard").scrollIntoView({ behavior: "smooth", block: "start" });
}
function overlapNote(pid, s, e, excludeId) {
  const o = staysFor(pid).find(x => x.id !== excludeId && s <= effEnd(x) && x.start_date <= e);
  return o ? T().tOverlap(countryName(o.country), fmt(toNum(o.start_date)), fmt(toNum(effEnd(o)))) : null;
}

function bindEvents() {
  // Auth
  $("authForm").addEventListener("submit", onAuthSubmit);
  document.querySelectorAll("#authTabs button").forEach(b => b.addEventListener("click", () => setAuthMode(b.dataset.mode)));
  $("aForgot").addEventListener("click", () => setAuthMode(S.authMode === "reset" ? "login" : "reset"));
  $("aBack").addEventListener("click", () => enterApp());
  $("authLangSel").addEventListener("change", e => setLang(e.target.value));

  // Navigation & Accounts
  document.querySelectorAll(".nav-btn").forEach(b => b.addEventListener("click", () => switchPanel(b.dataset.panel)));
  $("viewProfile").addEventListener("change", e => { S.viewId = e.target.value; lsSet("s9_view_" + backend.activeId(), S.viewId); S.calStart = S.calEnd = null; if (!S.editingId) profileOptions($("fProfile"), S.viewId); renderAll(); });
  $("accBtn").addEventListener("click", openAccounts);
  $("accBackdrop").addEventListener("click", closeAccounts);
  document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!$("accLayer").hidden) closeAccounts(); else if (!$("report").hidden) closeReport(); } });
  $("accList").addEventListener("click", e => {
    const a = e.target.closest("[data-acc]"); if (a) return switchAccount(a.dataset.acc);
    if (e.target.closest("[data-acc-add]")) { closeAccounts(); showAuth("login"); return; }
    if (e.target.closest("[data-acc-out]")) signOut();
  });
  $("signOutBtn").addEventListener("click", signOut);

  // Home
  $("goAdd").addEventListener("click", () => { cancelEdit(); switchPanel("trips"); $("fStart").focus(); });
  $("checkForm").addEventListener("submit", e => {
    e.preventDefault();
    const s = $("checkStart").value, en = $("checkEnd").value;
    const err = validateRange(s, en);
    showErr("checkErr", err, ["checkStart", "checkEnd"]);
    if (err || !S.viewId) { $("checkResult").hidden = true; return; }
    $("checkResult").innerHTML = resultHtml(checkRange(S.viewId, s, en), s);
    $("checkResult").hidden = false;
  });
  ["checkStart", "checkEnd"].forEach(id => $(id).addEventListener("change", () => {
    const s = $("checkStart").value, e = $("checkEnd").value;
    if (s) $("checkEnd").min = s;
    $("checkResult").hidden = true;
    showErr("checkErr", s && e && e < s ? "eOrder" : null, ["checkStart", "checkEnd"]);
  }));

  // Formular
  $("fCancel").addEventListener("click", cancelEdit);
  $("fOpen").addEventListener("change", () => { $("fEnd").disabled = $("fOpen").checked; if ($("fOpen").checked) $("fEnd").value = ""; showErr("fDateErr", null, ["fStart", "fEnd"]); updateFormPreview(); });
  ["fStart", "fEnd", "fProfile"].forEach(id => $(id).addEventListener("input", () => {
    const s = $("fStart").value, e = $("fEnd").value;
    if (s) $("fEnd").min = s;
    showErr("fDateErr", !$("fOpen").checked && s && e && e < s ? "eOrder" : null, ["fStart", "fEnd"]);
    updateFormPreview();
  }));
  $("tripForm").addEventListener("submit", async e => {
    e.preventDefault();
    const t = T(), pid = $("fProfile").value, open = $("fOpen").checked;
    const s = $("fStart").value, en = open ? null : $("fEnd").value;
    let err = validateRange(s, en, open);
    if (!err && open && toNum(s) > todayNum()) err = "eOpenFuture";
    if (!err && open && staysFor(pid).some(x => !x.end_date && x.id !== S.editingId)) err = "eOpenExists";
    showErr("fDateErr", err, ["fStart", "fEnd"]);
    if (err || !pid) return;
    const wasEdit = !!S.editingId;
    const note = overlapNote(pid, s, en || toIso(todayNum()), S.editingId);
    const ok = await act(() => backend.upsertStay({ id: S.editingId || undefined, profile_id: pid, country: $("fCountry").value, start_date: s, end_date: en }), null, $("fSubmit"));
    if (!ok) return;
    if (pid !== S.viewId) { S.viewId = pid; renderAll(); }
    cancelEdit();
    toast(note || (wasEdit ? t.tUpdated : t.tAdded), note ? "warn" : "");
  });
  $("tripList").addEventListener("click", e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.act === "edit") startEdit(id);
    else if (b.dataset.act === "del") { S.pendingDel = id; renderTrips(); }
    else if (b.dataset.act === "del-no") { S.pendingDel = null; renderTrips(); }
    else if (b.dataset.act === "del-yes") { S.pendingDel = null; if (S.editingId === id) cancelEdit(); act(() => backend.deleteStay(id), T().tDeleted, b); }
  });
  $("openReport").addEventListener("click", openReport);

  // Kalender
  $("calPrev").addEventListener("click", () => { S.calMonth.m--; if (S.calMonth.m < 0) { S.calMonth.m = 11; S.calMonth.y--; } renderCalendar(); });
  $("calNext").addEventListener("click", () => { S.calMonth.m++; if (S.calMonth.m > 11) { S.calMonth.m = 0; S.calMonth.y++; } renderCalendar(); });
  $("calToday").addEventListener("click", () => { S.calMonth = null; renderCalendar(); });
  $("months").addEventListener("click", e => {
    const c = e.target.closest(".day[data-n]"); if (!c) return;
    const n = +c.dataset.n;
    if (S.calStart === null || S.calEnd !== null) { S.calStart = n; S.calEnd = null; }
    else if (n < S.calStart) { S.calEnd = S.calStart; S.calStart = n; }
    else S.calEnd = n;
    if (S.calEnd !== null) profileOptions($("cProfile"), S.viewId);
    renderCalendar();
    if (S.calEnd !== null && window.matchMedia("(max-width: 1099px)").matches) $("selCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("cProfile").addEventListener("change", updateSelPreview);
  $("cCancel").addEventListener("click", () => { S.calStart = S.calEnd = null; renderCalendar(); });
  $("cSave").addEventListener("click", async e => {
    const pid = $("cProfile").value, s = toIso(S.calStart), en = toIso(S.calEnd);
    const note = overlapNote(pid, s, en);
    const ok = await act(() => backend.upsertStay({ profile_id: pid, country: $("cCountry").value, start_date: s, end_date: en }), null, e.currentTarget);
    if (!ok) return;
    S.calStart = S.calEnd = null;
    if (pid !== S.viewId) S.viewId = pid;
    renderAll();
    toast(note || T().tAdded, note ? "warn" : "");
  });
  window.matchMedia("(min-width: 1100px)").addEventListener("change", () => S.data && renderCalendar());

  // Einstellungen
  $("langSelect").addEventListener("change", e => setLang(e.target.value));
  $("tzSelect").addEventListener("change", e => { S.tz = e.target.value; lsSet("s9_tz", S.tz); S.calMonth = null; renderAll(); });
  document.querySelectorAll("#themeSeg button").forEach(b => b.addEventListener("click", () => { S.theme = b.dataset.themeVal; lsSet("s9_theme", S.theme); applyTheme(); renderSettings(); }));
  $("nameForm").addEventListener("submit", e => {
    e.preventDefault();
    const n = $("myName").value.trim(); if (!n) return;
    act(() => backend.updateName(n), T().nameSaved, e.submitter);
  });
  $("pwForm").addEventListener("submit", async e => {
    e.preventDefault();
    const pw = $("newPw").value;
    if (pw.length < 8) return showErr("pwErr", "eWeak", ["newPw"]);
    showErr("pwErr", null, ["newPw"]);
    if (await act(() => backend.updatePassword(pw), T().pwChanged, e.submitter)) { $("newPw").value = ""; S.recovery = false; }
  });
  $("addPersonForm").addEventListener("submit", async e => {
    e.preventDefault();
    const n = $("newPersonName").value.trim(); if (!n) return;
    const p = await act(() => backend.createProfile(n), T().profileAdded(n), e.submitter);
    if (p) { $("newPersonName").value = ""; if (p.id) { S.viewId = p.id; renderAll(); } }
  });
  $("peopleList").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target, input = f.querySelector("input"), t = T();
    if (f.dataset.share) {
      const email = input.value.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) { toast(t.eEmail, "warn"); input.focus(); return; }
      const r = await act(() => backend.shareProfile(f.dataset.share, email), r => r === "self" ? t.invSelf : r === "added" ? t.invAdded(email) : t.invInvited(email), f.querySelector("button"));
      if (r) input.value = "";
    } else if (f.dataset.renameform) {
      const n = input.value.trim(); if (!n) return;
      S.pendingAct = null;
      await act(() => f.dataset.renameform === (S.data.profiles.find(p => p.owner_id === me().id && p.is_self) || {}).id ? backend.updateName(n) : backend.renameProfile(f.dataset.renameform, n), t.renamed);
    }
  });
  $("peopleList").addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    const t = T(), ask = S.pendingAct;
    if (b.dataset.pa === "no") { S.pendingAct = null; renderPeople(); return; }
    if (b.dataset.pa === "yes" && ask) {
      S.pendingAct = null;
      if (ask.kind === "rm") await act(() => backend.removeMember(ask.pid, ask.uid), null, b);
      if (ask.kind === "delprof") { await act(() => backend.deleteProfile(ask.pid), t.profileDeleted, b); }
      if (ask.kind === "leave") await act(() => backend.removeMember(ask.pid, me().id), t.left, b);
      renderPeople(); return;
    }
    if (b.dataset.rename) { S.pendingAct = { kind: "rename", pid: b.dataset.rename }; renderPeople(); const i = $("peopleList").querySelector("[data-renameform] input"); if (i) { i.focus(); i.select(); } }
    else if (b.dataset.delprof) { S.pendingAct = { kind: "delprof", pid: b.dataset.delprof }; renderPeople(); }
    else if (b.dataset.leave) { S.pendingAct = { kind: "leave", pid: b.dataset.leave }; renderPeople(); }
    else if (b.dataset.rm) { S.pendingAct = { kind: "rm", pid: b.dataset.rm, uid: b.dataset.uid }; renderPeople(); }
    else if (b.dataset.uninv) act(() => backend.cancelInvite(b.dataset.uninv, b.dataset.email), null, b);
  });
  $("reportBtn2").addEventListener("click", openReport);
  $("reportClose").addEventListener("click", closeReport);
  $("reportPrint").addEventListener("click", () => window.print());
  $("reportRange").addEventListener("change", e => { S.reportRange = e.target.value; lsSet("s9_report_range", S.reportRange); renderReport(); });

  // Backup
  $("exportBtn").addEventListener("click", () => {
    const p = profileById(S.viewId); if (!p) return;
    const data = { app: "daycount", version: 3, exported: new Date().toISOString(), person: p.name,
      stays: staysFor(p.id).map(s => ({ country: s.country, start: s.start_date, end: s.end_date })) };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = `daycount-${p.name.replace(/[^\w-]+/g, "_")}-${toIso(todayNum())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(T().tExported);
  });

  // Installation
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); S.installEvt = e; if (S.data) renderInstall(); });
  window.addEventListener("appinstalled", () => { S.installEvt = null; if (S.data) renderInstall(); });
  window.addEventListener("online", () => S.data && refresh());
  window.addEventListener("offline", () => { S.offline = true; S.data && renderChrome(); });
  // Mitternacht: "heute" aktualisieren, wenn die App offen bleibt
  let lastDay = todayNum();
  setInterval(() => { if (todayNum() !== lastDay) { lastDay = todayNum(); if (S.data) renderAll(); } }, 60000);
}

function registerSW() {
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW", e));
}

bindEvents();
boot();
