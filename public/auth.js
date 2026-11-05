/* Taste Radar sign-in. Loaded first. If /api/config answers (the Vercel site), the page stays behind a sign-in screen
   until the visitor is signed in with Supabase; then the taste profile is saved to (and loaded from) their account. */
(function () {
  "use strict";
  var LS; try { LS = window.localStorage; } catch (e) { LS = null; }
  var KEYS = ["tr4", "tr_ver"];                       // what is saved to the cloud (the posters cache stays on the device)
  var rawSet = LS ? Storage.prototype.setItem.bind(LS) : function () {};
  var rawDel = LS ? Storage.prototype.removeItem.bind(LS) : function () {};
  var root = null;

  function mount() {
    root = document.createElement("div");
    root.id = "tr-gate";
    root.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:radial-gradient(ellipse at 50% 30%,#14181d,#0b0d10 70%);display:grid;place-items:center;padding:16px;font-family:Archivo,system-ui,-apple-system,Segoe UI,sans-serif;color:#eef1f4;overflow:auto";
    ["keydown", "keyup", "keypress", "pointerdown", "click"].forEach(function (t) { root.addEventListener(t, function (e) { e.stopPropagation(); }); });
    document.body.appendChild(root);
  }
  function card(html) {
    root.innerHTML = '<div style="width:min(400px,100%);background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:28px 24px;backdrop-filter:blur(8px)">' + html + "</div>";
    return root.firstChild;
  }
  var INP = "width:100%;box-sizing:border-box;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:12px 14px;color:#eef1f4;font:inherit;font-size:15px;margin-top:10px;outline:none";
  var BTN = "width:100%;box-sizing:border-box;border:0;border-radius:10px;padding:13px 14px;font:inherit;font-weight:600;font-size:15px;cursor:pointer;margin-top:14px";
  var HEAD = '<div style="font:500 10px/1 ui-monospace,monospace;letter-spacing:.3em;text-transform:uppercase;color:#66ffd6;opacity:.85">Taste Radar</div>';

  function message(title, body) {
    card(HEAD + '<h1 style="font:italic 300 30px/1.15 \'Cormorant Garamond\',Georgia,serif;margin:14px 0 8px">' + title + '</h1><p style="margin:0;opacity:.7;line-height:1.5;font-size:14px">' + body + "</p>");
  }

  function loadLib() {
    return new Promise(function (res, rej) {
      if (window.supabase) return res();
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js";
      s.onload = res; s.onerror = function () { rej(new Error("Couldn't load the sign-in library.")); };
      document.head.appendChild(s);
    });
  }

  function loginScreen(sb, cfg) {
    return new Promise(function (resolve) {
      var done = false, mode = "in";
      sb.auth.onAuthStateChange(function (ev, s) { if (s && !done) { done = true; resolve(s); } });
      function render() {
        var c = card(HEAD +
          '<h1 style="font:italic 300 32px/1.15 \'Cormorant Garamond\',Georgia,serif;margin:14px 0 4px">' + (mode === "in" ? "Sign in to continue" : "Create your account") + "</h1>" +
          '<p style="margin:0 0 6px;opacity:.65;font-size:14px;line-height:1.5">Your taste profile is saved to your account, so it follows you to any device.</p>' +
          (cfg.google ? '<button id="g" style="' + BTN + ';background:#fff;color:#111">Continue with Google</button><div style="text-align:center;opacity:.45;font-size:12px;margin:14px 0 0">or with email</div>' : "") +
          '<form id="f"><input id="e" type="email" autocomplete="email" placeholder="Email" required style="' + INP + '">' +
          '<input id="p" type="password" autocomplete="' + (mode === "in" ? "current-password" : "new-password") + '" placeholder="Password (6+ characters)" minlength="6" required style="' + INP + '">' +
          '<button id="go" type="submit" style="' + BTN + ';background:#66ffd6;color:#06201a">' + (mode === "in" ? "Sign in" : "Create account") + "</button></form>" +
          '<div id="m" style="min-height:20px;margin-top:12px;font-size:13px;line-height:1.4;color:#ff9d9d"></div>' +
          '<button id="t" style="background:none;border:0;color:#eef1f4;opacity:.7;font:inherit;font-size:13px;cursor:pointer;padding:0;text-decoration:underline">' + (mode === "in" ? "New here? Create an account" : "Have an account? Sign in") + "</button>");
        var msg = c.querySelector("#m"), say = function (t, ok) { msg.textContent = t; msg.style.color = ok ? "#66ffd6" : "#ff9d9d"; };
        c.querySelector("#t").onclick = function () { mode = mode === "in" ? "up" : "in"; render(); };
        var g = c.querySelector("#g");
        if (g) g.onclick = function () { sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin } }); };
        c.querySelector("#f").onsubmit = async function (ev) {
          ev.preventDefault();
          var go = c.querySelector("#go"), email = c.querySelector("#e").value.trim(), pw = c.querySelector("#p").value;
          go.disabled = true; go.style.opacity = ".6"; say("");
          var r = mode === "in" ? await sb.auth.signInWithPassword({ email: email, password: pw }) : await sb.auth.signUp({ email: email, password: pw });
          go.disabled = false; go.style.opacity = "1";
          if (r.error) { say(r.error.message); return; }
          if (mode === "up" && !r.data.session) say("Check your email to confirm your account, then sign in.", true);
        };
      }
      render();
    });
  }

  async function main() {
    mount();
    var cfg = null;
    try {
      var r = await fetch("/api/config", { cache: "no-store", signal: AbortSignal.timeout(3500) });
      if (r.ok && /json/.test(r.headers.get("content-type") || "")) cfg = await r.json();
    } catch (e) { /* no backend here (a preview, or opened as a file): no sign-in screen */ }
    if (!cfg) { root.remove(); return; }
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) { message("Sign-in isn't set up yet", "Add SUPABASE_URL and SUPABASE_ANON_KEY in Vercel's Environment Variables, then redeploy."); return; }
    try { await loadLib(); } catch (e) { message("Couldn't load", "Check your connection and refresh the page."); return; }
    var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    var session = (await sb.auth.getSession()).data.session;
    if (!session) session = await loginScreen(sb, cfg);
    var uid = session.user.id;

    // every call to the site's own /api carries the visitor's session; a 401 means the session ended
    var nativeFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      var u = typeof input === "string" ? input : (input && input.url) || "";
      var mine = /^\/api\//.test(u) || u.indexOf(location.origin + "/api/") === 0;
      if (mine) {
        var s = (await sb.auth.getSession()).data.session;
        if (s) { init = Object.assign({}, init); var h = new Headers(init.headers || (typeof input !== "string" && input.headers) || {}); h.set("authorization", "Bearer " + s.access_token); init.headers = h; }
      }
      var res = await nativeFetch(input, init);
      if (mine && res.status === 401) { await sb.auth.signOut(); location.reload(); }
      return res;
    };

    // save / load the profile
    function snapshot() { var o = {}; KEYS.forEach(function (k) { var v = LS && LS.getItem(k); if (v != null) o[k] = v; }); return o; }
    async function push() {
      var r = await sb.from("user_data").upsert({ user_id: uid, data: snapshot(), updated_at: new Date().toISOString() }).select("updated_at").single();
      if (!r.error && r.data) rawSet("tr_sync_at", r.data.updated_at);
    }
    if (LS) {
      var got = await sb.from("user_data").select("data,updated_at").eq("user_id", uid).maybeSingle();
      if (!got.error) {
        var row = got.data, marker = LS.getItem("tr_sync_at");
        var lv = LS.getItem("tr_ver");
        if (row && row.data && row.data.tr_ver && lv && row.data.tr_ver !== lv) { await push(); }   // saved by another app version: keep this one
        else if (row && row.data && (!marker || Date.parse(row.updated_at) > Date.parse(marker))) {
          var changed = false;
          KEYS.forEach(function (k) {
            if (k in row.data) { if (LS.getItem(k) !== row.data[k]) { rawSet(k, row.data[k]); changed = true; } }
            else if (LS.getItem(k) != null) { rawDel(k); changed = true; }
          });
          rawSet("tr_sync_at", row.updated_at);
          if (changed) { location.reload(); return; }      // the page restarts with the account's saved profile
        } else if (!row) { await push(); }
      }
      var timer = null, rel = function (k) { return KEYS.indexOf(k) >= 0; };
      var origSet = Storage.prototype.setItem, origDel = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (k, v) { origSet.call(this, k, v); if (this === LS && rel(k)) { clearTimeout(timer); timer = setTimeout(push, 1200); } };
      Storage.prototype.removeItem = function (k) { origDel.call(this, k); if (this === LS && rel(k)) { clearTimeout(timer); timer = setTimeout(push, 1200); } };
      document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden" && timer) { clearTimeout(timer); timer = null; push(); } });
    }
    root.remove();

    // a small sign-out link, shown once the opening animation is over
    var chip = document.createElement("button");
    chip.textContent = "Sign out";
    chip.title = session.user.email || "";
    chip.style.cssText = "position:fixed;left:14px;bottom:12px;z-index:2147482000;display:none;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.14);color:#eef1f4;opacity:.6;border-radius:999px;padding:6px 12px;font:500 11px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;cursor:pointer";
    chip.onclick = async function () { try { await push(); } catch (e) {} await sb.auth.signOut(); if (LS) { KEYS.concat(["tr_sync_at"]).forEach(rawDel); } location.reload(); };
    document.body.appendChild(chip);
    setInterval(function () { chip.style.display = document.getElementById("glass") ? "none" : "block"; }, 700);
  }
  main().catch(function (e) { if (root) message("Something went wrong", String(e && e.message || e)); });
})();
