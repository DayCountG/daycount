"use strict";
/* ============================================================
   Backend: Accounts, Profile, Freigaben, Aufenthalte
   - SupabaseBackend: echte Cloud-Datenbank (wenn config.js ausgefüllt ist)
   - MockBackend: Demo-Modus, alles im Browser (zum Testen)
   Beide haben exakt dieselbe Schnittstelle.
   Fehler werden als { code } geworfen: exists | invalid | unconfirmed | weak | forbidden | network | notfound | unknown
   ============================================================ */

const REG_KEY = "s9_accounts", ACTIVE_KEY = "s9_active";
const appErr = (code, detail) => Object.assign(new Error(code), { code, detail });
const normEmail = e => String(e || "").trim().toLowerCase();
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// Liste der auf diesem Gerät angemeldeten Accounts (wie bei Instagram)
const Registry = {
  list() { try { const r = JSON.parse(localStorage.getItem(REG_KEY) || "[]"); return Array.isArray(r) ? r : []; } catch (e) { return []; } },
  save(list) { try { localStorage.setItem(REG_KEY, JSON.stringify(list)); } catch (e) {} },
  activeId() { try { return localStorage.getItem(ACTIVE_KEY) || ""; } catch (e) { return ""; } },
  setActive(id) { try { if (id) localStorage.setItem(ACTIVE_KEY, id); else localStorage.removeItem(ACTIVE_KEY); } catch (e) {} },
  active() { const id = this.activeId(); return this.list().find(a => a.id === id) || null; },
  upsert(acc) { const l = this.list().filter(a => a.id !== acc.id); l.push(acc); this.save(l); this.setActive(acc.id); },
  remove(id) { this.save(this.list().filter(a => a.id !== id)); if (this.activeId() === id) this.setActive(""); }
};

/* ============================================================
   Demo-Backend (localStorage). Mehrere Tabs = mehrere "Geräte".
   ============================================================ */
class MockBackend {
  constructor() {
    this.mode = "demo";
    this.listeners = new Set();
    window.addEventListener("storage", e => { if (e.key === "s9_mock_db") this.emit(); });
  }
  db() {
    try { const d = JSON.parse(localStorage.getItem("s9_mock_db")); if (d && d.users) return d; } catch (e) {}
    return { users: [], profiles: [], members: [], invites: [], stays: [] };
  }
  save(d) { localStorage.setItem("s9_mock_db", JSON.stringify(d)); this.emit(); }
  emit() { this.listeners.forEach(fn => { try { fn(); } catch (e) {} }); }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async hash(pw) {
    if (!crypto.subtle) return "plain:" + pw;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("s9demo:" + pw));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  me() { const a = Registry.active(); if (!a) return null; const u = this.db().users.find(x => x.id === a.id); return u ? { id: u.id, email: u.email, name: u.name } : null; }
  uid() { const m = this.me(); if (!m) throw appErr("invalid"); return m.id; }
  can(d, pid, uid) { const p = d.profiles.find(x => x.id === pid); return !!p && (p.owner_id === uid || d.members.some(m => m.profile_id === pid && m.user_id === uid)); }
  afterLogin(d, u) {
    // offene Einladungen einlösen + eigenes Profil sicherstellen
    for (const inv of d.invites.filter(i => i.email === u.email)) {
      if (!d.members.some(m => m.profile_id === inv.profile_id && m.user_id === u.id)) d.members.push({ profile_id: inv.profile_id, user_id: u.id, email: u.email });
    }
    d.invites = d.invites.filter(i => i.email !== u.email);
    if (!d.profiles.some(p => p.owner_id === u.id && p.is_self)) d.profiles.push({ id: rid(), owner_id: u.id, owner_email: u.email, name: u.name, is_self: true, created_at: new Date().toISOString() });
    this.save(d);
    Registry.upsert({ id: u.id, email: u.email, name: u.name });
  }

  async handleRedirect() { return null; }
  async restore() { return this.me(); }
  accounts() { return Registry.list(); }
  activeId() { return Registry.activeId(); }
  async switchTo(id) { Registry.setActive(id); return this.me(); }

  async signUp(name, email, pw) {
    email = normEmail(email);
    if (pw.length < 8) throw appErr("weak");
    const d = this.db();
    if (d.users.some(u => u.email === email)) throw appErr("exists");
    const u = { id: rid(), email, name: name.trim(), pw: await this.hash(pw) };
    d.users.push(u);
    this.afterLogin(d, u);
    return { ok: true };
  }
  async signIn(email, pw) {
    email = normEmail(email);
    const d = this.db();
    const u = d.users.find(x => x.email === email);
    if (!u || u.pw !== await this.hash(pw)) throw appErr("invalid");
    this.afterLogin(d, u);
    return { ok: true };
  }
  async resetPassword() { return { demo: true }; }
  async updatePassword(pw) {
    if (pw.length < 8) throw appErr("weak");
    const d = this.db(); const u = d.users.find(x => x.id === this.uid());
    u.pw = await this.hash(pw); this.save(d);
  }
  async updateName(name) {
    const d = this.db(), uid = this.uid();
    d.users.find(x => x.id === uid).name = name;
    const p = d.profiles.find(x => x.owner_id === uid && x.is_self); if (p) p.name = name;
    Registry.upsert({ ...Registry.active(), name });
    this.save(d);
  }
  async signOut() { const a = Registry.active(); if (a) Registry.remove(a.id); }

  async loadAll() {
    const d = this.db(), uid = this.uid();
    const profiles = d.profiles.filter(p => this.can(d, p.id, uid));
    const ids = new Set(profiles.map(p => p.id));
    return {
      me: this.me(),
      profiles: JSON.parse(JSON.stringify(profiles)),
      members: d.members.filter(m => ids.has(m.profile_id)),
      invites: d.invites.filter(i => ids.has(i.profile_id)),
      stays: d.stays.filter(s => ids.has(s.profile_id))
    };
  }
  async createProfile(name) {
    const d = this.db(), me = this.me();
    const p = { id: rid(), owner_id: me.id, owner_email: me.email, name, is_self: false, created_at: new Date().toISOString() };
    d.profiles.push(p); this.save(d); return p;
  }
  async renameProfile(id, name) {
    const d = this.db(); if (!this.can(d, id, this.uid())) throw appErr("forbidden");
    d.profiles.find(p => p.id === id).name = name; this.save(d);
  }
  async deleteProfile(id) {
    const d = this.db(), p = d.profiles.find(x => x.id === id);
    if (!p || p.owner_id !== this.uid() || p.is_self) throw appErr("forbidden");
    d.profiles = d.profiles.filter(x => x.id !== id);
    d.members = d.members.filter(x => x.profile_id !== id);
    d.invites = d.invites.filter(x => x.profile_id !== id);
    d.stays = d.stays.filter(x => x.profile_id !== id);
    this.save(d);
  }
  async upsertStay(s) {
    const d = this.db(); if (!this.can(d, s.profile_id, this.uid())) throw appErr("forbidden");
    const row = { id: s.id || rid(), profile_id: s.profile_id, country: s.country, start_date: s.start_date, end_date: s.end_date || null };
    const i = d.stays.findIndex(x => x.id === row.id);
    if (i >= 0) d.stays[i] = row; else d.stays.push(row);
    this.save(d); return row;
  }
  async deleteStay(id) {
    const d = this.db(), s = d.stays.find(x => x.id === id);
    if (!s || !this.can(d, s.profile_id, this.uid())) throw appErr("forbidden");
    d.stays = d.stays.filter(x => x.id !== id); this.save(d);
  }
  async shareProfile(pid, email) {
    email = normEmail(email);
    const d = this.db(), me = this.me(), p = d.profiles.find(x => x.id === pid);
    if (!p || p.owner_id !== me.id) throw appErr("forbidden");
    if (email === me.email) return "self";
    const u = d.users.find(x => x.email === email);
    if (u) {
      if (!d.members.some(m => m.profile_id === pid && m.user_id === u.id)) d.members.push({ profile_id: pid, user_id: u.id, email });
      this.save(d); return "added";
    }
    if (!d.invites.some(i => i.profile_id === pid && i.email === email)) d.invites.push({ profile_id: pid, email });
    this.save(d); return "invited";
  }
  async removeMember(pid, userId) {
    const d = this.db(), p = d.profiles.find(x => x.id === pid), uid = this.uid();
    if (!p || (p.owner_id !== uid && userId !== uid)) throw appErr("forbidden");
    d.members = d.members.filter(m => !(m.profile_id === pid && m.user_id === userId)); this.save(d);
  }
  async cancelInvite(pid, email) {
    const d = this.db(), p = d.profiles.find(x => x.id === pid);
    if (!p || p.owner_id !== this.uid()) throw appErr("forbidden");
    d.invites = d.invites.filter(i => !(i.profile_id === pid && i.email === email)); this.save(d);
  }
}

/* ============================================================
   Supabase-Backend
   ============================================================ */
class SupabaseBackend {
  constructor(url, key) {
    this.mode = "cloud";
    this.url = url; this.key = key;
    this.clients = new Map();
    this.listeners = new Set();
    this.channel = null;
  }
  client(storageKey) {
    if (!this.clients.has(storageKey)) {
      this.clients.set(storageKey, window.supabase.createClient(this.url, this.key, {
        auth: { storageKey, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      }));
    }
    return this.clients.get(storageKey);
  }
  get c() { const a = Registry.active(); if (!a) throw appErr("invalid"); return this.client(a.key); }
  redirectUrl() { return location.origin + location.pathname; }
  mapErr(error) {
    if (!error) return appErr("unknown");
    const m = String(error.message || "").toLowerCase();
    if (error instanceof TypeError || /fetch|network|offline/.test(m)) return appErr("network");
    if (/already registered|already exists/.test(m)) return appErr("exists");
    if (/invalid login|invalid credentials/.test(m)) return appErr("invalid");
    if (/not confirmed/.test(m)) return appErr("unconfirmed");
    if (/password/.test(m) && /(short|weak|least)/.test(m)) return appErr("weak");
    if (/permission|row-level|forbidden|not allowed/.test(m) || error.code === "42501") return appErr("forbidden");
    return appErr("unknown", error.message);
  }
  async run(promise) {
    let res;
    try { res = await promise; } catch (e) { throw this.mapErr(e); }
    if (res && res.error) throw this.mapErr(res.error);
    return res ? res.data : undefined;
  }
  async register(user, storageKey) {
    Registry.upsert({ id: user.id, email: user.email, name: (user.user_metadata && user.user_metadata.name) || user.email.split("@")[0], key: storageKey });
    await this.afterLogin();
  }
  async afterLogin() {
    const c = this.c, me = await this.restore();
    await this.run(c.rpc("claim_invites"));
    const own = await this.run(c.from("profiles").select("id").eq("owner_id", me.id).eq("is_self", true));
    if (!own.length) await this.run(c.from("profiles").insert({ name: me.name, is_self: true }));
  }
  // Links aus E-Mails (Bestätigung, Passwort zurücksetzen) landen mit Tokens in der URL
  async handleRedirect() {
    const h = new URLSearchParams(location.hash.slice(1));
    const at = h.get("access_token"), rt = h.get("refresh_token");
    if (!at || !rt) return null;
    history.replaceState(null, "", location.pathname + location.search);
    const key = "sb-" + rid();
    const c = this.client(key);
    const data = await this.run(c.auth.setSession({ access_token: at, refresh_token: rt }));
    await this.register(data.user, key);
    return h.get("type") || "signin";
  }
  async restore() {
    const a = Registry.active(); if (!a) return null;
    const c = this.client(a.key);
    const { data } = await c.auth.getSession();
    if (!data || !data.session) {
      if (!navigator.onLine) return { id: a.id, email: a.email, name: a.name, offline: true };
      Registry.remove(a.id); return null;
    }
    const u = data.session.user;
    return { id: u.id, email: u.email, name: (u.user_metadata && u.user_metadata.name) || a.name };
  }
  accounts() { return Registry.list(); }
  activeId() { return Registry.activeId(); }
  async switchTo(id) { Registry.setActive(id); return this.restore(); }

  async signUp(name, email, pw) {
    const key = "sb-" + rid(), c = this.client(key);
    const data = await this.run(c.auth.signUp({ email: normEmail(email), password: pw, options: { data: { name: name.trim() }, emailRedirectTo: this.redirectUrl() } }));
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw appErr("exists");
    if (!data.session) return { confirm: true };
    await this.register(data.user, key);
    return { ok: true };
  }
  async signIn(email, pw) {
    const key = "sb-" + rid(), c = this.client(key);
    const data = await this.run(c.auth.signInWithPassword({ email: normEmail(email), password: pw }));
    await this.register(data.user, key);
    return { ok: true };
  }
  async resetPassword(email) {
    await this.run(this.client("sb-reset").auth.resetPasswordForEmail(normEmail(email), { redirectTo: this.redirectUrl() }));
    return { sent: true };
  }
  async updatePassword(pw) { await this.run(this.c.auth.updateUser({ password: pw })); }
  async updateName(name) {
    const c = this.c, me = await this.restore();
    await this.run(c.auth.updateUser({ data: { name } }));
    await this.run(c.from("profiles").update({ name }).eq("owner_id", me.id).eq("is_self", true));
    Registry.upsert({ ...Registry.active(), name });
  }
  async signOut() {
    const a = Registry.active(); if (!a) return;
    try { await this.client(a.key).auth.signOut({ scope: "local" }); } catch (e) {}
    this.clients.delete(a.key);
    Registry.remove(a.id);
  }
  subscribe(fn) {
    this.listeners.add(fn);
    this.resubscribe();
    return () => this.listeners.delete(fn);
  }
  resubscribe() {
    try { if (this.channel) this.channel.unsubscribe(); } catch (e) {}
    this.channel = null;
    if (!Registry.active()) return;
    const emit = () => this.listeners.forEach(f => { try { f(); } catch (e) {} });
    this.channel = this.c.channel("s9-" + rid())
      .on("postgres_changes", { event: "*", schema: "public", table: "stays" }, emit)
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, emit)
      .on("postgres_changes", { event: "*", schema: "public", table: "profile_members" }, emit)
      .subscribe();
  }
  async loadAll() {
    const c = this.c;
    const me = await this.restore();
    if (!me) throw appErr("invalid");
    const [profiles, members, invites, stays] = await Promise.all([
      this.run(c.from("profiles").select("id, owner_id, owner_email, name, is_self, created_at")),
      this.run(c.from("profile_members").select("profile_id, user_id, email")),
      this.run(c.from("invites").select("profile_id, email")),
      this.run(c.from("stays").select("id, profile_id, country, start_date, end_date"))
    ]);
    // Datumswerte immer als reines JJJJ-MM-TT verwenden, egal in welchem Format die Datenbank sie liefert
    const day = v => v ? String(v).slice(0, 10) : null;
    return { me, profiles, members, invites, stays: stays.map(s => ({ ...s, start_date: day(s.start_date), end_date: day(s.end_date) })) };
  }
  async createProfile(name) { return this.run(this.c.from("profiles").insert({ name, is_self: false }).select().single()); }
  async renameProfile(id, name) { await this.run(this.c.from("profiles").update({ name }).eq("id", id)); }
  async deleteProfile(id) { await this.run(this.c.from("profiles").delete().eq("id", id).eq("is_self", false)); }
  async upsertStay(s) {
    const row = { profile_id: s.profile_id, country: s.country, start_date: s.start_date, end_date: s.end_date || null, updated_at: new Date().toISOString() };
    if (s.id) return this.run(this.c.from("stays").update(row).eq("id", s.id).select().single());
    return this.run(this.c.from("stays").insert(row).select().single());
  }
  async deleteStay(id) { await this.run(this.c.from("stays").delete().eq("id", id)); }
  async shareProfile(pid, email) { return this.run(this.c.rpc("share_profile", { p_profile: pid, p_email: normEmail(email) })); }
  async removeMember(pid, userId) { await this.run(this.c.from("profile_members").delete().eq("profile_id", pid).eq("user_id", userId)); }
  async cancelInvite(pid, email) { await this.run(this.c.from("invites").delete().eq("profile_id", pid).eq("email", email)); }
}

function createBackend() {
  const cfg = window.APP_CONFIG || {};
  if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase) return new SupabaseBackend(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  return new MockBackend();
}
