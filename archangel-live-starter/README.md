# Archangel — free-hosting starter

This package gives you:
1. A deployable static website (`public/index.html`) for Cloudflare Pages.
2. A Supabase database schema for sources and stories.
3. A Supabase Edge Function starter that fetches RSS feeds, deduplicates stories, and optionally summarises them using an OpenAI-compatible API.
4. Deployment steps and security notes.

## Important current state
The existing front-end is still a prototype with illustrative story cards. This starter adds backend scaffolding; it does not magically connect the existing page to the database yet. The Edge Function can ingest RSS feeds into Supabase once configured. The UI integration is the next step after you create the hosted services and supply their project URLs/keys.

## Free hosting route

### A. Publish the prototype on Cloudflare Pages
1. Create a GitHub account and a new repository named `archangel`.
2. Upload the contents of this folder to the repository. Ensure `public/index.html` is at the expected build output path.
3. In Cloudflare, open Workers & Pages → Create application → Pages → Connect to Git.
4. Select the repository. Set the build command to `exit 0` and the build output directory to `public`.
5. Deploy. Cloudflare provides a `*.pages.dev` URL.
6. Later changes pushed to GitHub trigger a new deployment.

Cloudflare's static asset requests are free and unlimited on Pages; dynamic Functions have separate quotas. Official guide: https://developers.cloudflare.com/pages/framework-guides/deploy-anything/

### B. Create a Supabase free project
1. Create a project at https://supabase.com/.
2. Open SQL Editor and run `supabase/schema.sql`.
3. In Project Settings → Edge Functions / Secrets, set:
   - `SUPABASE_URL` (project URL)
   - `SUPABASE_SERVICE_ROLE_KEY` (service-role key; secret only, never expose in browser)
   - `OPENAI_API_KEY` (optional; needed only if you want AI summaries)
   - `SUMMARY_MODEL` (optional; set to a model available to your API account)
4. Deploy the Edge Function in `supabase/functions/ingest-feeds/`.
5. Add a source row for each RSS feed in the `sources` table, setting `enabled = true`.
6. Trigger the function manually first; inspect the `stories` table to confirm ingestion.
7. Edit `public/config.js` and set `supabaseUrl` plus the public anon/publishable key. These values allow the front-end to read stories under the SQL read policies.

Supabase free-tier limits can change and free projects may pause after inactivity. Check: https://supabase.com/pricing

### C. Schedule ingestion
For the first test, invoke the function manually from the Supabase dashboard. For automatic collection, use Supabase Cron/pg_cron if enabled for your project, or an external free scheduler that calls the function URL with a secret header. Keep the secret in the scheduler's secret store, not in the public website.

### D. AI summaries
If `OPENAI_API_KEY` is absent, the function stores the feed title and a short feed-description/excerpt as a fallback summary. If present, it sends only the available feed text (not full paywalled article pages) to the configured API. AI API usage is typically billed separately from hosting. Review the current model price before enabling it.

## RSS source setup
The schema is deliberately source-agnostic. Add only feeds whose terms permit your intended use. Prefer official institutional RSS feeds and press-release feeds. Some institutions change their feed URLs or do not offer RSS; test each URL before enabling it. Do not scrape sites that prohibit it or republish full copyrighted articles.

## Security before a public launch
- Keep `SUPABASE_SERVICE_ROLE_KEY` and `OPENAI_API_KEY` server-side only.
- Do not make the `sources` table writable to anonymous users.
- Add rate limiting, error monitoring, and validation before accepting user-submitted feeds.
- Verify attribution, timestamps, source URL, and religious figure identity.
- Treat summaries as editorial aids; retain the original link and clearly label summaries as AI-generated.
- This is a starter, not a finished production backend. UI-to-database integration, authentication, privacy policy, and testing are still required.
