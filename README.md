# Taste Radar on Vercel, with login and a database (all free)

Everything here runs on free tiers: Vercel (hosting + API), Supabase (login + database), Gemini and OMDb (your existing keys).

## 1. Supabase (login + database)
1. Go to https://supabase.com, sign in with GitHub, click New project. Pick any name and a database password (save it) and the region nearest you (Mumbai if offered). Wait about 2 minutes.
2. Left sidebar, SQL Editor, New query. Paste the whole of `supabase.sql`, click Run. It should say "Success".
3. Authentication, Sign In / Providers, Email: leave it enabled and turn OFF "Confirm email". Save. (If it stays on, sign-up needs a confirmation email and the free email quota is tiny.)
4. Project Settings, API (or Data API / API Keys): copy the Project URL (`https://xxxx.supabase.co`) and the anon / public key. Never use the service_role key. The anon key is meant to be public; row-level security keeps each person's data private.

## 2. GitHub
1. https://github.com/new, create a repo named `taste-radar-vercel` (private is fine).
2. Click "uploading an existing file", then drag in the contents of this folder (api, lib, public, package.json, vercel.json, supabase.sql), not the zip itself. Commit.

## 3. Vercel
1. https://vercel.com, sign up with GitHub, Add New, Project, import `taste-radar-vercel`.
2. Framework Preset: Other. Leave Build Command and Output Directory empty (vercel.json sets them).
3. Environment Variables (add all four):
   - `GEMINI_API_KEY` = your Gemini key
   - `OMDB_API_KEY` = your OMDb key
   - `SUPABASE_URL` = Project URL from step 1.4
   - `SUPABASE_ANON_KEY` = anon key from step 1.4
   Optional: `GEMINI_MODEL`, and `GOOGLE_LOGIN=1` if you set up Google sign-in (below).
4. Deploy. You get `https://taste-radar-vercel-xxxx.vercel.app`.
5. Back in Supabase, Authentication, URL Configuration: set Site URL to that Vercel URL and add it under Redirect URLs.

## 4. Test
- Open `/api/check` on your URL. It should show your keys as ready.
- Open the site, create an account, build a profile, then open the site on another device and sign in. The profile follows you.
- If you change an env var later, press Redeploy in Vercel.

## Optional: Google sign-in
Google Cloud Console, APIs & Services, Credentials, Create OAuth client ID (Web). Authorized redirect URI: `https://<your-project>.supabase.co/auth/v1/callback`. Paste the Client ID and Secret into Supabase, Authentication, Providers, Google. Then add `GOOGLE_LOGIN=1` on Vercel and redeploy.

## Notes
- All of `/api/*` returns 401 without a signed-in user, so strangers can't burn your Gemini quota.
- Supabase free projects pause after about a week of no use; click Restore in the dashboard.
- Vercel Hobby is for non-commercial use. Gemini free-tier rate limits apply.
- The Cloudflare "backup AI" isn't available on Vercel; Gemini only.
