// Microsoft sign-in (OAuth 2 authorization code + PKCE, no library) and OneDrive files via Microsoft Graph.
"use strict";

const Auth = (() => {
  const BASE = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
  const SCOPES = "Files.ReadWrite offline_access openid profile";
  const KEY = "chores.tokens";
  const PKCE = "chores.pkce";
  const redirectUri = () => location.origin + location.pathname;

  function b64url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function random(n) {
    return b64url(crypto.getRandomValues(new Uint8Array(n)));
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
  }
  function save(t) { localStorage.setItem(KEY, JSON.stringify(t)); }

  async function login() {
    const verifier = random(48);
    const state = random(16);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    localStorage.setItem(PKCE, JSON.stringify({ verifier, state }));
    const q = new URLSearchParams({
      client_id: CONFIG.clientId, response_type: "code", redirect_uri: redirectUri(), scope: SCOPES,
      code_challenge: challenge, code_challenge_method: "S256", state, response_mode: "query",
    });
    location.assign(`${BASE}/authorize?${q}`);
    return new Promise(() => {}); // page is leaving
  }

  async function tokenRequest(params) {
    const res = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CONFIG.clientId, scope: SCOPES, ...params }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error_description || body.error || "sign-in failed");
    const t = { access: body.access_token, refresh: body.refresh_token, exp: Date.now() + (body.expires_in - 120) * 1000 };
    save(t);
    return t;
  }

  // Call once at start: finishes a sign-in that just came back from Microsoft.
  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.has("code") && !p.has("error")) return;
    history.replaceState(null, "", redirectUri());
    if (p.has("error")) throw new Error(p.get("error_description") || p.get("error"));
    const saved = JSON.parse(localStorage.getItem(PKCE) || "{}");
    localStorage.removeItem(PKCE);
    if (!saved.state || saved.state !== p.get("state")) throw new Error("Sign-in expired, please try again.");
    await tokenRequest({ grant_type: "authorization_code", code: p.get("code"), redirect_uri: redirectUri(),
      code_verifier: saved.verifier });
  }

  // A valid access token, refreshing it if needed; null if you need to sign in.
  async function token(force = false) {
    const t = load();
    if (!t) return null;
    if (!force && t.access && t.exp > Date.now()) return t.access;
    if (!t.refresh) return null;
    try {
      return (await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh })).access;
    } catch {
      localStorage.removeItem(KEY);
      return null;
    }
  }

  return {
    login, handleRedirect, token,
    signedIn: () => !!load(),
    logout() { localStorage.removeItem(KEY); },
  };
})();

const Cloud = (() => {
  const GRAPH = "https://graph.microsoft.com/v1.0";

  class Conflict extends Error {}

  async function graph(path, opts = {}, retried = false) {
    const tok = await Auth.token(retried);
    if (!tok) return Auth.login();
    const res = await fetch(GRAPH + path, { ...opts, headers: { Authorization: "Bearer " + tok, ...(opts.headers || {}) } });
    if (res.status === 401 && !retried) return graph(path, opts, true);
    return res;
  }

  const itemPath = (name) => `/me/drive/root:/${encodeURIComponent(CONFIG.folder)}/${encodeURIComponent(name)}`;

  // -> {text, etag}; text is null if the file does not exist yet
  async function read(name) {
    const meta = await graph(itemPath(name));
    if (meta.status === 404) return { text: null, etag: null };
    if (!meta.ok) throw new Error(`Could not read ${name} (${meta.status})`);
    const item = await meta.json();
    const res = await fetch(item["@microsoft.graph.downloadUrl"], { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not download ${name} (${res.status})`);
    return { text: await res.text(), etag: item.eTag };
  }

  // Writes only if the file is unchanged since it was read (etag), so the phone never
  // overwrites something the PC saved a moment ago.
  async function write(name, text, etag) {
    const headers = { "Content-Type": "text/plain" };
    if (etag) headers["If-Match"] = etag;
    const res = await graph(itemPath(name) + ":/content", { method: "PUT", headers, body: text });
    if (res.status === 412) throw new Conflict(name);
    if (!res.ok) throw new Error(`Could not save ${name} (${res.status})`);
    return (await res.json()).eTag;
  }

  async function readJSON(name, fallback) {
    const { text, etag } = await read(name);
    return { data: text ? JSON.parse(text) : fallback, etag };
  }

  // Read, change, write; on a clash with another device, read again and redo the change.
  async function update(name, fallback, mutate) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, etag } = await readJSON(name, fallback);
      const result = mutate(data);
      try {
        await write(name, JSON.stringify(data, null, 2), etag);
        return { data, result };
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
      }
    }
    throw new Error("Another device kept changing " + name + ". Try again.");
  }

  async function appendLine(name, line) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { text, etag } = await read(name);
      const body = (text || "").replace(/\s*$/, "\n") + line + "\n";
      try {
        return await write(name, body.replace(/^\n/, ""), etag);
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
      }
    }
    throw new Error("Could not add it, try again.");
  }

  return { readJSON, update, appendLine };
})();
