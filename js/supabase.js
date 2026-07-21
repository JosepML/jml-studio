// Cliente ligero para Supabase (Auth + REST) sin dependencias externas.
// Sustituye a @supabase/supabase-js: solo usa fetch(), pensado para funcionar
// como PWA estática sin paso de compilación.

const CFG = window.APP_CONFIG;
const REST_URL = `${CFG.SUPABASE_URL}/rest/v1`;
const AUTH_URL = `${CFG.SUPABASE_URL}/auth/v1`;

const Session = {
  KEY: "jml_session",
  get() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || "null"); }
    catch { return null; }
  },
  set(session) { localStorage.setItem(this.KEY, JSON.stringify(session)); },
  clear() { localStorage.removeItem(this.KEY); },
};

async function authFetch(path, opts = {}) {
  const res = await fetch(`${AUTH_URL}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY, ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { data: null, error: json.error_description || json.msg || json.error || `Error ${res.status}` };
  return { data: json, error: null };
}

export const auth = {
  async signIn(email, password) {
    const { data, error } = await authFetch("/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (error) return { error };
    Session.set(data);
    return { data };
  },
  async refresh() {
    const s = Session.get();
    if (!s || !s.refresh_token) return { error: "sin sesión" };
    const { data, error } = await authFetch("/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (error) { Session.clear(); return { error }; }
    Session.set(data);
    return { data };
  },
  signOut() { Session.clear(); },
  currentUser() {
    const s = Session.get();
    return s ? s.user : null;
  },
  isLoggedIn() { return !!Session.get()?.access_token; },

  // Supabase manda los enlaces de invitación y de "olvidé mi contraseña" con
  // los tokens en el hash de la URL (#access_token=...&type=invite|recovery).
  // Esto los detecta, arranca la sesión y dice si hace falta pedir una
  // contraseña nueva antes de dejar entrar al usuario.
  async completeFromUrlHash() {
    const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    const params = new URLSearchParams(hash);

    const hashError = params.get("error_description") || params.get("error");
    if (hashError) {
      history.replaceState(null, "", location.pathname + location.search);
      return { handled: true, error: decodeURIComponent(hashError).replace(/\+/g, " ") + " — pide un enlace nuevo." };
    }

    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    const type = params.get("type");
    if (!access_token) return { handled: false };

    const res = await fetch(`${AUTH_URL}/user`, {
      headers: { apikey: CFG.SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
    });
    const user = await res.json().catch(() => null);
    if (!res.ok || !user) return { handled: true, error: "El enlace ha caducado o ya se usó. Pide uno nuevo." };

    Session.set({ access_token, refresh_token, token_type: "bearer", user });
    history.replaceState(null, "", location.pathname + location.search);
    return { handled: true, needsPassword: type === "invite" || type === "recovery" };
  },

  async setPassword(newPassword) {
    const s = Session.get();
    if (!s?.access_token) return { error: "sin sesión" };
    const res = await fetch(`${AUTH_URL}/user`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY, Authorization: `Bearer ${s.access_token}` },
      body: JSON.stringify({ password: newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error_description || data.msg || `Error ${res.status}` };
    Session.set({ ...s, user: data });
    return { data };
  },
};

async function restRequest(table, { method = "GET", params = new URLSearchParams(), body, prefer } = {}) {
  let session = Session.get();
  const doFetch = () => fetch(`${REST_URL}/${table}?${params.toString()}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: CFG.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token || CFG.SUPABASE_ANON_KEY}`,
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let res = await doFetch();
  if (res.status === 401 && session?.refresh_token) {
    const r = await auth.refresh();
    if (!r.error) { session = Session.get(); res = await doFetch(); }
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) return { data: null, error: data?.message || `Error ${res.status}` };
  return { data, error: null };
}

class QueryBuilder {
  constructor(table) {
    this.table = table;
    this.params = new URLSearchParams();
    this.method = "GET";
    this.body = undefined;
    this.prefer = "return=representation";
    this._single = false;
  }
  select(cols = "*") { this.params.set("select", cols); return this; }
  eq(col, val) { this.params.append(col, `eq.${val}`); return this; }
  order(col, { ascending = true } = {}) { this.params.set("order", `${col}.${ascending ? "asc" : "desc"}`); return this; }
  limit(n) { this.params.set("limit", n); return this; }
  gte(col, val) { this.params.append(col, `gte.${val}`); return this; }
  lte(col, val) { this.params.append(col, `lte.${val}`); return this; }
  single() { this._single = true; this.params.set("limit", "1"); return this; }
  insert(row) { this.method = "POST"; this.body = row; return this; }
  update(row) { this.method = "PATCH"; this.body = row; return this; }
  delete() { this.method = "DELETE"; return this; }

  async exec() {
    const { data, error } = await restRequest(this.table, {
      method: this.method, params: this.params, body: this.body, prefer: this.prefer,
    });
    if (error) return { data: null, error };
    if (this._single) return { data: Array.isArray(data) ? (data[0] || null) : data, error: null };
    return { data, error: null };
  }
}

export const db = {
  from(table) { return new QueryBuilder(table); },
};
