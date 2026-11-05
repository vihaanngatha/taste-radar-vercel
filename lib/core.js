// Taste Radar backend for Vercel (shared by the files in /api). Every call except /api/config needs a signed-in user.
//   POST /api/ask      { prompt, tier }        -> { result }      the AI, via Google's Gemini free tier
//   GET  /api/posters  ?k=game|movie&t=A|B|C   -> { posters: { A: url|null, ... } }   from Wikipedia
//   GET  /api/verify   ?t=Title~Year|...       -> { enabled, ratings: { Title~Year: {...}|null } }   real IMDb / Rotten Tomatoes / Metacritic figures from OMDb
// The Gemini key lives in the GEMINI_API_KEY secret, never in the page, so visitors can't copy it.
// Free-tier safety: with no billing linked to the Google project, Gemini can only refuse
// (rate limit), never charge. Title scores are cached for a week, posters for 30 days.

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}


// ---------------------------------------------------------------- small helpers for Vercel
// A tiny in-memory cache with the same match()/put() shape the Cloudflare version used. It lives as long as the
// server instance does; the browser also caches posters and ratings itself.
const mem = new Map();
const cache = {
  async match(req) { const e = mem.get(req.url); if (!e || e.exp < Date.now()) return undefined; return e.res.clone(); },
  async put(req, res) {
    const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") || "");
    if (mem.size > 400) mem.delete(mem.keys().next().value);
    mem.set(req.url, { res: res.clone(), exp: Date.now() + (m ? +m[1] * 1000 : 600000) });
  },
};

// Is this request from a signed-in user? The page sends the user's Supabase session token; Supabase confirms it.
// (If Supabase isn't configured the answer is no, so the site can't be used without login by mistake.)
const okTokens = new Map();
async function signedIn(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return false;
  const h = request.headers.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!tok) return false;
  const hit = okTokens.get(tok);
  if (hit && hit > Date.now()) return true;
  try {
    const r = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/user", {
      headers: { apikey: env.SUPABASE_ANON_KEY, authorization: "Bearer " + tok }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return false;
    if (okTokens.size > 500) okTokens.clear();
    okTokens.set(tok, Date.now() + 60000);
    return true;
  } catch { return false; }
}

export async function handle(route, request, ctx) {
  const env = process.env;
  const later = (p) => { try { ctx && ctx.waitUntil ? ctx.waitUntil(p) : p.catch(() => {}); } catch { /* ignore */ } };
  if (route === "config") {
    // The page asks this first: is login set up, and which sign-in options to show. Both values are public by design.
    return json({ supabaseUrl: env.SUPABASE_URL || "", supabaseAnonKey: env.SUPABASE_ANON_KEY || "", google: env.GOOGLE_LOGIN === "1" }, 200, { "cache-control": "no-store" });
  }
  if (route === "check") return check(env);
  if (!(await signedIn(request, env))) return json({ error: "Please sign in." }, 401);
  if (route === "ask") {
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    return ask(request, env, later);
  }
  if (route === "posters") return posters(request, later);
  if (route === "verify") return verify(request, env, later);
  return json({ error: "Not found." }, 404);
}

// ---------------------------------------------------------------- the AI

// Free models, best first (checked November 2026). GEMINI_MODEL, if set, is tried first.
// Google's newest free models are often overloaded (error 503), and free limits are counted per
// model, so when one is busy, out of quota or gives a broken answer, we move on to the next.
const FULL_MODELS = ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash"];
const LITE_MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite"];
const HEDGE_MS = 8000; // if the main model hasn't answered by now, race a faster Lite model too
let workingModel = null; // remembered while this Worker instance is alive
let discovered = null;   // models Google says this key can use, looked up once

// The three kinds of question the page asks, and the exact answer shape Google must return.
// Forcing the shape stops lighter models from sending lists the page can't read.
const NUM5 = { type: "ARRAY", items: { type: "NUMBER" } };
const STRS = { type: "ARRAY", items: { type: "STRING" } };
// Tags shared with the survey's deep dive (pace, depth, moods, ...), so the page can match them.
const TRAITS = { type: "OBJECT", nullable: true, properties: {
  pace: { type: "STRING" }, depth: { type: "STRING" }, moods: STRS, focus: { type: "STRING" },
  themes: STRS, setting: STRS, length: { type: "STRING" }, flags: STRS,
} };
const SCHEMAS = {
  score: {
    type: "OBJECT",
    properties: {
      known: { type: "BOOLEAN" }, title: { type: "STRING" }, year: { type: "INTEGER", nullable: true },
      summary: { type: "STRING" },
      scores: { type: "ARRAY", items: { type: "OBJECT", properties: {
        s: { type: "NUMBER" }, conf: { type: "STRING" }, why: { type: "STRING" },
      }, required: ["s", "conf", "why"] } },
      traits: TRAITS,
    },
    required: ["known"],
  },
  recs: {
    type: "OBJECT",
    properties: { recs: { type: "ARRAY", items: { type: "OBJECT", properties: {
      title: { type: "STRING" }, year: { type: "INTEGER", nullable: true }, creator: { type: "STRING" },
      genres: STRS, len: { type: "STRING" }, why: { type: "STRING" }, highlight: { type: "STRING" },
      scores: NUM5, traits: TRAITS,
    }, required: ["title", "scores", "why"] } } },
    required: ["recs"],
  },
  items: {
    type: "OBJECT",
    properties: { items: { type: "ARRAY", items: { type: "OBJECT", properties: {
      title: { type: "STRING" }, year: { type: "INTEGER", nullable: true }, scores: NUM5,
    }, required: ["title", "scores"] } } },
    required: ["items"],
  },
};
const kindOf = (p) => (p.includes("Title requested:") ? "score" : p.includes('"recs"') ? "recs" : p.includes('"items"') ? "items" : null);

// Is the answer usable? Lists need enough complete entries; a score needs five numbers.
function usable(kind, x) {
  if (!x || typeof x !== "object") return false;
  const five = (a) => Array.isArray(a) && a.length === 5 && a.every((v) => Number.isFinite(+(v?.s ?? v)));
  if (kind === "score") return x.known === false || five(x.scores);
  const list = x[kind];
  return Array.isArray(list) && list.filter((i) => i && i.title && five(i.scores)).length >= (kind === "recs" ? 4 : 2);
}

// Scoring needs knowledge, not deep reasoning, so keep the model's "thinking" to a minimum: it is the
// main source of delay. Gemini 3+ uses thinkingLevel; 2.x uses a thinking budget (0 = off).
const thinkingFor = (model) => (/gemini-2\./.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" });

async function callGemini(model, prompt, key, schema, timeoutMs) {
  const send = (opts) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.6,
          ...(opts.schema ? { responseSchema: opts.schema } : {}),
          ...(opts.thinking ? { thinkingConfig: opts.thinking } : {}),
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  // If a model rejects a setting (error 400), or chokes on the forced answer shape (error 500),
  // step down: drop thinking, then the forced shape.
  let r;
  for (const opts of [{ thinking: thinkingFor(model), schema }, { schema }, {}]) {
    r = await send(opts);
    if (r.status !== 400 && !(r.status === 500 && opts.schema)) break;
  }
  return r;
}

function parseAnswer(data) {
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : ""); } catch { return null; }
}

async function discoverModels(key) {
  if (discovered) return discovered;
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const { models = [] } = await r.json();
    const names = models
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /flash/.test(n) && !/image|tts|live|audio|embed|preview|exp/.test(n));
    const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
    names.sort((x, y) => (/lite/.test(x) - /lite/.test(y)) || ver(y) - ver(x)); // full first, newest first
    discovered = names;
    return names;
  } catch { return []; }
}

// Backup AI: Cloudflare Workers AI runs inside this Worker (the "AI" binding in wrangler.jsonc).
// It is free up to a daily allowance and needs no key. Used only when Gemini can't answer.
const CF_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct"];
async function callWorkersAI(env, prompt, kind) {
  if (!env.AI) return null;
  for (const m of CF_MODELS) {
    try {
      const out = await Promise.race([
        env.AI.run(m, {
          messages: [
            { role: "system", content: "Reply with one JSON object only. No prose, no code fences." },
            { role: "user", content: prompt },
          ],
          max_tokens: kind === "score" ? 1100 : 4500,
          temperature: 0.4,
        }),
        new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 30000)),
      ]);
      const r = out?.response;
      const result = r && typeof r === "object" ? r : parseAnswer({ candidates: [{ content: { parts: [{ text: String(r || "") }] } }] });
      if (usable(kind, result)) return { result, m };
    } catch { /* try the next one */ }
  }
  return null;
}

async function ask(request, env, waitUntil) {
  const url = new URL(request.url);

  // Only this site's own page may call the backend.
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== url.host) return json({ error: "Not allowed." }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400); }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const kind = kindOf(prompt);
  // Accept only Taste Radar's own prompts, so the key can't be used as a free chatbot.
  if (!prompt || prompt.length > 9000 || !/JSON only/i.test(prompt) || !kind)
    return json({ error: "Bad request." }, 400);
  if (!env.GEMINI_API_KEY) {
    // No Google key (for example, it was removed in Cloudflare's settings): keep working on
    // Cloudflare's own AI instead of failing.
    const backup = await callWorkersAI(env, prompt, kind);
    if (backup) return json({ result: backup.result, backup: true });
    return json({ error: "The site's AI key is missing. Add GEMINI_API_KEY as a Secret in Cloudflare." }, 500);
  }

  // Cache title scores (they don't change). Lists are never cached, so they stay fresh.
  const cache = cache;
  const cacheKey = new Request(url.origin + "/__cache/" + (await sha256(prompt)));
  if (kind === "score") {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  // Remember which model answered last (shared by every visitor for 15 minutes), so nobody
  // waits through models that were just busy for someone else.
  const memo = new Request(url.origin + "/__model");
  const outKey = (m) => new Request(url.origin + "/__out/" + encodeURIComponent(m));

  // Each title is scored twice and the two are averaged. The second pass goes to Cloudflare's own
  // AI: two different AIs agreeing is a stronger check than one AI asked twice, and it halves the
  // use of Google's small free quota. If Cloudflare's AI can't answer, Google does that pass too.
  if (kind === "score" && /\(pass B\)/.test(prompt)) {
    const partner = await callWorkersAI(env, prompt, kind);
    if (partner) {
      const res = json({ result: partner.result, partner: true }, 200, { "cache-control": "public, max-age=604800" });
      waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }
  }
  if (!workingModel) workingModel = (await (await cache.match(memo))?.text()) || null;

  const isList = kind !== "score";
  const perCall = isList ? 30000 : 12000; // lists are longer answers, so they get more time
  const deadline = Date.now() + (isList ? 60000 : 30000);
  const st = { quota: false, busy: false, bad: false, hard: null };
  let finished = false;
  const tryList = async (list) => {
    for (const m of [...new Set(list.filter(Boolean))]) {
      if (finished || Date.now() > deadline) return null;
      if (await cache.match(outKey(m))) { st.quota = true; continue; } // out of quota recently: skip it
      let res;
      try { res = await callGemini(m, prompt, env.GEMINI_API_KEY, SCHEMAS[kind], perCall); }
      catch { st.busy = true; continue; } // timed out or network hiccup
      if (res.ok) {
        const result = parseAnswer(await res.json().catch(() => null));
        if (usable(kind, result)) return { result, m };
        st.bad = true; continue; // broken or too-short answer: try the next model
      }
      if (res.status === 429) {
        st.quota = true;
        // Remember it's out: a daily limit is skipped for 6 hours, a per-minute limit for 1 minute.
        const why = await res.text().catch(() => "");
        const secs = /per ?day|PerDay|daily|current quota/i.test(why) ? 21600 : 60;
        waitUntil(cache.put(outKey(m), new Response("out", { headers: { "cache-control": `max-age=${secs}` } })));
      }
      if (res.status >= 500) st.busy = true;
      st.last = res.status; // any other error: note it and try the next model
    }
    return null;
  };
  const isLite = (m) => /lite/.test(m || "");
  let full = [env.GEMINI_MODEL, isLite(workingModel) ? null : workingModel, ...FULL_MODELS];
  let lite = [isLite(workingModel) ? workingModel : null, ...LITE_MODELS];
  if (body.tier === "quick") [full, lite] = [lite, full]; // simple jobs: fast model first

  // Main list now; the backup list joins the race if the main one is slow. First good answer wins.
  // (If the main list fails outright, the backup list starts at once instead of waiting.)
  let win = await new Promise((resolve) => {
    let left = 2, started = false;
    const done = (v) => { if (v && !finished) { finished = true; resolve(v); } else if (--left === 0) resolve(null); };
    const startLite = () => { if (started) return; started = true; (finished ? Promise.resolve(null) : tryList(lite)).then(done); };
    tryList(full).then((v) => { done(v); if (!v) startLite(); });
    setTimeout(startLite, HEDGE_MS);
  });
  finished = true;
  if (!win) {
    // Every known name failed: ask Google which models this key can use and try those.
    finished = false;
    win = await tryList((await discoverModels(env.GEMINI_API_KEY)).slice(0, 6));
    finished = true;
  }

  if (!win) {
    // Google couldn't help this time: use Cloudflare's own free AI as a backup, so the site keeps working.
    const backup = await callWorkersAI(env, prompt, kind);
    if (backup) return json({ result: backup.result, backup: true }); // not cached: Gemini may do better next time
    if (st.quota && !st.busy)
      return json({ code: "rate_limited", error: "The free AI limit is used up for now." }, 429);
    if (st.busy || st.quota)
      return json({ code: "busy", error: "Google's free AI is overloaded right now. Try again in a minute." }, 503);
    return json({ error: st.last ? `The AI service returned an error (${st.last}).` : "The AI gave an unreadable answer. Try again." }, 502);
  }

  workingModel = win.m;
  waitUntil(cache.put(memo, new Response(win.m, { headers: { "cache-control": "max-age=900" } })));
  const res = json({ result: win.result }, 200, kind === "score" ? { "cache-control": "public, max-age=604800" } : {});
  if (kind === "score") waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// ---------------------------------------------------------------- posters

// Posters come from Wikipedia: the lead image of a game's or film's article is normally its cover
// or poster. No key needed. Up to 12 titles are looked up in ONE Wikipedia request, by trying the
// article names Wikipedia uses ("3 Idiots (2009 film)", "Hades (video game)", ...). Before an image
// is used, the article's own short description must say it is a film/show or a video game, and
// match the year when we know it, so a remake, a book or a band with the same name is skipped.
// Titles still without a picture fall back to a search. Answers are cached for 30 days.
const UA = { "User-Agent": "TasteRadar/1.0 (https://github.com/vihaanngatha/taste-radar; student portfolio project)", "Api-User-Agent": "TasteRadar/1.0 (https://github.com/vihaanngatha/taste-radar)" };
const WIKI = "https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&prop=pageimages%7Cdescription&piprop=thumbnail&pithumbsize=400&pilicense=any";
const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const goodImg = (p) => (p?.thumbnail?.source && !/\.svg/i.test(p.thumbnail.source) ? p.thumbnail.source : null);

// Is this article really the title we want?
function fits(p, k, y) {
  if (!goodImg(p)) return false;
  const d = (p.description || "").toLowerCase();
  if (/disambiguation|topics referred to|list of/.test(d)) return false;
  const kindOk = k === "game" ? /video ?game|game/.test(d) : /film|movie|television|tv series|web series|miniseries|anime/.test(d);
  if (d && !kindOk) return false;
  if (y && d) {
    const years = (d.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
    if (years.length && !years.some((v) => Math.abs(v - y) <= 1)) return false;
  }
  return true;
}

function articleNames(t, k, y) {
  return k === "game"
    ? [...(y ? [`${t} (${y} video game)`] : []), `${t} (video game)`, t]
    : [...(y ? [`${t} (${y} film)`] : []), `${t} (film)`, `${t} (TV series)`, t];
}

async function searchPoster(t, k, y) {
  const want = norm(t);
  const q = `${t} ${y || ""} ${k === "game" ? "video game" : "film"}`.replace(/\s+/g, " ");
  try {
    const r = await fetch(WIKI + "&generator=search&gsrlimit=6&gsrsearch=" + encodeURIComponent(q), { headers: UA, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const pages = ((await r.json()).query?.pages || []).filter((p) => fits(p, k, y)).sort((a, b) => a.index - b.index);
    const bare = (p) => norm(p.title.replace(/\s*\([^)]*\)\s*$/, ""));
    const pick = pages.find((p) => bare(p) === want) || pages.find((p) => norm(p.title).startsWith(want));
    return pick ? goodImg(pick) : null;
  } catch { return null; }
}

async function posters(request, waitUntil) {
  const url = new URL(request.url);
  const k = url.searchParams.get("k") === "movie" ? "movie" : "game";
  // each entry is "Title" or "Title~Year"
  const items = [...new Map((url.searchParams.get("t") || "").split("|").map((x) => {
    const [t, y] = x.split("~");
    return [t.trim().slice(0, 120), /^\d{4}$/.test(y || "") ? +y : null];
  }).filter(([t]) => t)).entries()].slice(0, 12);
  if (!items.length) return json({ posters: {} }, 400);
  const cache = cache;
  const key = new Request(url.origin + "/__posters3/" + k + "/" + (await sha256(items.map(([t, y]) => t.toLowerCase() + "~" + (y || "")).join("|"))));
  const hit = await cache.match(key);
  if (hit) return hit;

  // One request for every likely article name of every title.
  const names = [...new Set(items.flatMap(([t, y]) => articleNames(t, k, y)))].slice(0, 50);
  const byName = {};
  let wikiOk = false;
  try {
    const r = await fetch(WIKI + "&redirects=1&titles=" + encodeURIComponent(names.join("|")), { headers: UA, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      wikiOk = true;
      const q = (await r.json()).query || {};
      const hop = {};
      for (const x of [...(q.normalized || []), ...(q.redirects || [])]) hop[x.from] = x.to;
      const pages = {};
      for (const p of q.pages || []) pages[p.title] = p;
      for (const n of names) {
        let x = n;
        for (let i = 0; i < 3 && hop[x]; i++) x = hop[x]; // follow normalisation and redirects
        byName[n] = pages[x] || null;
      }
    }
  } catch {}
  if (!wikiOk) return json({ posters: {}, error: "Wikipedia didn't answer." }, 502); // not cached: try again next time

  const out = {};
  for (const [t, y] of items) {
    const page = articleNames(t, k, y).map((n) => byName[n]).find((p) => p && fits(p, k, y));
    out[t] = page ? goodImg(page) : null;
  }
  // Titles still without a picture: search for them, all at once.
  await Promise.all(items.filter(([t]) => !out[t]).map(async ([t, y]) => { out[t] = await searchPoster(t, k, y); }));

  const res = json({ posters: out }, 200, { "cache-control": "public, max-age=2592000" });
  waitUntil(cache.put(key, res.clone()));
  return res;
}

// GET /api/check : a quick health check of the two outside services, for the site owner.
// Shows only status codes and timings (never the key). Uses at most two small AI calls.
async function check(env) {
  const out = { time: new Date().toISOString(), keySet: !!env.GEMINI_API_KEY, omdbKeySet: !!env.OMDB_API_KEY, rememberedModel: workingModel };
  const t0 = Date.now();
  try {
    const r = await fetch(WIKI + "&redirects=1&titles=" + encodeURIComponent("Hades (video game)|Inception"), { headers: UA, signal: AbortSignal.timeout(8000) });
    const body = await r.text();
    out.wikipedia = { status: r.status, ms: Date.now() - t0, sample: body.slice(0, 300) };
  } catch (e) { out.wikipedia = { error: String(e) }; }
  const prompt = 'You are scoring a video game. Title requested: "Portal 2" (pass A). Score 0-10 on 5 categories: Gameplay; Story; Beauty; Sound; Immersion. Reply with JSON only: {"known":true,"title":"","year":2011,"summary":"","scores":[{"s":7.5,"conf":"high","why":""}]}';
  out.ai = [];
  for (const m of [env.GEMINI_MODEL, ...FULL_MODELS.slice(0, 1), ...LITE_MODELS.slice(0, 1)].filter(Boolean).slice(0, 2)) {
    const t = Date.now();
    try {
      const r = await callGemini(m, prompt, env.GEMINI_API_KEY, SCHEMAS.score, 20000);
      const txt = await r.text();
      let ok = false; try { ok = usable("score", parseAnswer(JSON.parse(txt))); } catch {}
      out.ai.push({ model: m, status: r.status, usable: ok, ms: Date.now() - t, sample: txt.slice(0, 300) });
    } catch (e) { out.ai.push({ model: m, error: String(e), ms: Date.now() - t }); }
  }
  out.backupAI = { ready: false, note: "not used on Vercel (Gemini only)" };
  return json(out);
}

// ---------------------------------------------------------------- real ratings for movies & shows
// The AI suggests; OMDb (free key, 1,000 lookups a day) says how each title is actually rated, so the
// page can drop anything below its quality bar. Nothing is estimated: a title OMDb can't find is
// reported as unknown. Each title is cached for two weeks, so repeat lookups cost nothing.
async function omdbOne(key, title, year) {
  const ask = async (withYear) => {
    const u = "https://www.omdbapi.com/?apikey=" + encodeURIComponent(key) + "&t=" + encodeURIComponent(title) + (withYear && year ? "&y=" + year : "");
    const r = await fetch(u, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new Error("omdb " + r.status);
    const d = await r.json();
    return d && d.Response === "True" ? d : null;
  };
  let d = await ask(true);
  if (!d && year) d = await ask(false);
  if (!d) return null;
  const y0 = parseInt(String(d.Year || ""), 10);
  if (year && y0 && Math.abs(y0 - year) > 1) return null; // a different film or show with the same name
  const num = (x) => { const n = parseFloat(String(x || "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
  const src = (name) => ((d.Ratings || []).find((x) => x.Source === name) || {}).Value;
  return {
    title: d.Title, year: y0 || null, type: d.Type, imdb: num(d.imdbRating), votes: num(d.imdbVotes),
    rt: num(src("Rotten Tomatoes")), mc: num(d.Metascore),
    india: /India/i.test(d.Country || ""), hindi: /Hindi/i.test(d.Language || ""),
  };
}
async function verify(request, env, waitUntil) {
  const url = new URL(request.url);
  if (!env.OMDB_API_KEY) return json({ enabled: false, ratings: {} });
  const items = [...new Set((url.searchParams.get("t") || "").split("|").map((x) => x.trim()).filter(Boolean))].slice(0, 20);
  const cache = cache, out = {};
  await Promise.all(items.map(async (it) => {
    const [title, y] = it.split("~"), year = parseInt(y, 10) || null;
    const key = new Request(url.origin + "/__omdb1/" + (await sha256(title.toLowerCase() + "~" + (year || ""))));
    const hit = await cache.match(key);
    if (hit) { out[it] = await hit.json(); return; }
    try {
      const v = await omdbOne(env.OMDB_API_KEY, title, year);
      out[it] = v;
      waitUntil(cache.put(key, json(v, 200, { "cache-control": "public, max-age=" + (v ? 1209600 : 259200) })));
    } catch (e) { out[it] = { error: true }; } // not cached: try again next time
  }));
  return json({ enabled: true, ratings: out });
}

