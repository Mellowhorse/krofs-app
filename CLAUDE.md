# Krofs schilderbezoek-planner — working agreement

Read this first. It encodes the guardrails and locked decisions for this project.
If an instruction contradicts something here, **stop and surface it** rather than
proceeding.

## What this is
A tool for Krofs' relatiebeheerder (Kees) to plan physical visits to ~50
gedetacheerde schilders at changing client work-locations. Kees starts a weekly
round; the app WhatsApps each painter a no-login link; the painter submits their
work address + which days they're there; after a hard deadline the app clusters
per address and builds a per-day driving route from a fixed start
(IKEA Vathorst, Amersfoort).

Stack: Supabase (Postgres + Auth + Edge Functions [Deno] + pg_cron + pg_net +
Vault) + Next.js on Vercel. WhatsApp via Meta Cloud API direct (Twilio sandbox
for dev).

Status: **Phases 1–4 built + live** on Vercel (SEND_MODE=sandbox). DB migrations
001–009 applied to dev `wxhsyifejwlbothenjve`. Painter form, CSV import, round
dispatch (Meta outbox + cron), geocoding, and route building all verified
end-to-end on synthetic data. Pending on Chris: Meta Business verification +
UTILITY templates (real sends), GOOGLE_MAPS_API_KEY (live geocode + drive-times).

## Golden rules (guardrails — do not violate)
1. **No real sends in dev.** Every WhatsApp/SMS send MUST pass through
   `lib/send-guard`. Default `SEND_MODE=sandbox`: only numbers in
   `TEST_ALLOWLIST` may receive anything; real painter numbers are blocked.
   Going live requires `SEND_MODE=live` AND `LIVE_CONFIRM` set, plus Chris's
   explicit sign-off. Dispatch crons are disabled outside production.
2. **Synthetic data only until go-live.** Never load real painter phone numbers
   or real client addresses into dev/staging. Seed with fake data.
3. **Migrations are reviewed and applied to a dev branch first.** Never run a
   migration against a DB holding real data without Chris's sign-off. Every
   schema change is a numbered file in `db/`.
4. **Least privilege.** Use project-scoped dev credentials only. Secrets live in
   `.env` (gitignored) / Supabase Vault / Vercel env — never hardcoded, never
   committed, never printed in full. The browser only ever gets the anon key.
5. **Human approval at irreversible steps.** Stop and get Chris's OK before:
   applying a migration to real data; submitting the WhatsApp template to Meta;
   the first real send (a supervised 10-painter pilot, never a silent 50);
   enabling production crons.
6. **Scope is locked.** Build the MVP as defined below. Flag scope creep; don't
   silently add it. De-scoped items stay out.
7. **Definition of done** = tests green + one full dry-run round end-to-end on
   synthetic data + geocode/route sanity-checked on a few real NL addresses.
   If it can't be run and tested, it isn't done.
8. **Money guardrails.** GCP budget alert (~EUR 25/mo) + quota caps on Geocoding
   and Routes. Per-run send cap enforced by `send-guard`.

## Locked decisions
Process v3: manual "start weekronde" -> auto WhatsApp link per painter (dag 0) ->
no-login `/r/{token}`: full address (straat, huisnummer, postcode, plaats) +
werkdagen -> reminder = **next day, same wall-time** (DST-safe) -> deadline =
**day-0 convention**, closes at the local-midnight boundary of day 5, **hard stop**
(no grace) -> geocode + cluster **per address**, 30 min per address (group visit;
multiple painters at one address = one 30-min stop) -> per-day route from fixed
IKEA Vathorst (52.2478, 5.4147), ochtend+middag chained, each day restarts from
IKEA -> Kees drives ("open in Google Maps"). Late responders roll into the next
round.

Visit window: **one work week (ma–vr)** directly after close; the form offers
those 5 concrete dates. `visit_week_end = visit_week_start + 4`.

Roster: imported from a **spreadsheet via a CSV importer** (NL->E.164
normalization, dedupe on number, row-by-row preview). Painters seeded as
`opted_in` (`consent_source='admin_import'`).

BSP: **Meta Cloud API direct** (no markup); template must be **UTILITY** category.
Twilio sandbox for dev/testing only.

Accepted defaults: concrete-date picker; single-use link, no edit after submit;
75 km review threshold for far/odd geocodes; warn-only on oversubscribed days;
geocode retry 5x with backoff; "ik werk deze week niet" button; per-token +
per-IP rate limiting via a shared store (Upstash / Vercel KV).

## Product improvements v4 (approved by Chris, in db/003)
1. **Location freshness** — the form asks for the address of the **visit week**
   ("waar werk je in de week van 13–17 juli?"), not "this week". Plus a
   day-before **location-confirm ping** (`message_kind='location_confirm'`,
   `invite_responses.location_confirm_sent_at/location_confirmed_at`) — visits
   happen 8–13 days after fill-in while locations change weekly; this was the
   v1-identified top failure mode, reinstated.
2. **Visit tracking** — `route_stops.visited_at` ("gezien" tap) +
   `painter_last_visited` view = Kees's original "bijhouden wie je gezien
   hebt" ask. Enables a later longest-unseen-first priority rule for free.
3. **Prefill** — the form opens with "Werk je nog steeds op <laatste adres>?"
   [Ja] [Nee, ander adres] via the `painter_last_address` view. One tap for
   painters on long-running sites; the explicit confirm preserves the
   fresh-per-round guarantee. (Supersedes the earlier "no prefill" default.)
4. **Inbound fallback** — painters who reply in WhatsApp instead of using the
   link: inbound rows land in an unhandled queue (`message_log.handled_at`
   null) on the dashboard so Kees can enter the answer manually.
5. **`deadline_days` org setting** (default 5 = locked value) — the pilot can
   shorten the collection window without a migration.
6. **Route-ready notification** to Kees (`message_kind='route_ready'`) via the
   outbox when a plan reaches `ready`; channel = third UTILITY template or
   e-mail, decide at template submission.

## De-scoped (do NOT build for MVP)
Clients/inleners; opt-in bootstrap / consent capture (painters seeded opted_in);
GDPR/AVG lawful-basis flows; the old 50% gate; anti-starvation/aging (the data
for it now exists via `visited_at`, the rule itself stays out); native apps;
drag-reorder on the dashboard.

## Known drift — reconciliation status
The base schema (`db/001`) was generated before the reminder/deadline/grace
decisions and before the backend design's concurrency columns.

`db/002_reconcile.sql` — **written + adversarially reviewed, NOT yet applied**
(apply only to the dev project after Chris's sign-off; it has a fresh-DB guard).
It handles:
1. `reminder_at` -> next-day-same-wall-time (not `+24h`). ✔
2. `deadline_at` -> start of day 6 local (day-0 convention), compare `now() < deadline_at`;
   `token_expires_at` now trigger-stamped = `deadline_at` so it can't diverge. ✔
3. Drop the `is_late` remnant (hard stop); `carry_over_from_invite_id` kept only as the
   next-round re-invite link. ✔
4. Add missing columns: `route_plans.build_epoch/heartbeat_at/last_completed_visit_date/build_attempts`,
   `route_days.optimization_status`, `invite_responses.geocode_leased_until`,
   `round_invites.send_attempts` (+ watchdog/geocode-claim indexes). ✔
5. Add `visit_week_end` + both-bounds `workday_in_window`; visit window = first Mon–Fri
   strictly after the deadline date (send-weekday-independent). ✔

`db/003_product_improvements.sql` — the v4 product improvements above
(deadline_days, visited_at + views, location-confirm columns, inbound handled_at,
new message_kind values).

`db/004_security_hardening.sql` — pins `search_path` on the 7 trigger functions
and locks down `anonymize_painter` (service_role only) + `is_admin_of` (removes
anon; authenticated kept for RLS). Clears all Supabase security-advisor findings
except the accepted "authenticated can execute is_admin_of" (by-design RLS helper).

**APPLIED to the dev project `wxhsyifejwlbothenjve` (2026-07-10) via the Supabase
MCP**: 001→002→003→004 all live; 12 tables + RLS; time invariants verified against
the real DB (reminder next-day-same-walltime, deadline day-0 midnight, visit window
Mon–Fri after deadline, DST 23h check, deadline_days default 5). Region = eu-west-3.

`db/005_painter_rpcs.sql` — **APPLIED to dev + adversarially tested (9/9) against
the real DB, security-advisor clean**: the no-login painter gateway.
`get_invite_by_token` + `submit_response` (SECURITY DEFINER, service_role only,
sha256 token, fail-closed, single-use atomic claim, cross-token/tenant safe,
workdays validated in-window, prefill via `painter_last_address`, "geen werk" path).
The Next.js `/r/{token}` SERVER route calls these with the service_role key; the
browser never touches them. RPC regression tests added to `db/tests/smoke_test.sql`.

`db/006_round_dispatch.sql` — Phase 2 start. Original `start_weekronde` (superseded
by db/007) + `regenerate_invite_tokens`, which REMAINS as the manual wa.me fallback.

`db/007_outbox.sql` — Phase 2b: the AUTOMATED outbox (Meta Cloud API model).
`start_weekronde` now creates invites as `pending` (returns a count; tokens are
minted at SEND time, so raw tokens exist only in sweep memory).
`claim_invite_for_send` = outbox phase-1 claim (service_role): claims the
message_log slot FIRST (idempotency_key `kind:invite_id`; a `failed` row re-queues
= retry), THEN mints/rotates the token, returns raw token + phone once.
`close_due_rounds` = time-based day-5 hard close (+ expires non-responded invites).
`pending_invite_ids` / `due_reminder_ids` = sweep queries.
App side: `web/lib/whatsapp.ts` (Meta sender; SEND_MODE=sandbox → DRY-RUN, no
message leaves; live needs META_* + LIVE_CONFIRM via `web/lib/sendGuard.ts`),
`web/lib/sweeps.ts` (dispatch/reminders/close), `POST /api/tick` (x-cron-secret),
`scripts/cloudflare-worker.js` (free CF Worker cron `*/15` → /tick + Healthchecks
dead-man's-switch). `/admin/rondes`: "Verstuur berichten nu" runs the same sweep.
APPLIED to dev + verified end-to-end: start → 4 pending → dispatch 4 sent
(sandbox provider-ids, 0 payload leaked), tick idempotent (2nd run = 0), 401
without secret, reminder due→sent→stamped, day-5 close closes + expires.
NOTE: the anchor trigger makes deadline_at un-editable by design (recomputed from
sent_at) — test closes with a backdated `sent_at` INSERT, not an UPDATE.

`db/008_geocode.sql` — Phase 3: `claim_geocode_batch` (service_role atomic lease,
skip-locked, attempts<5) for the geocode sweep. App: `web/lib/geocode.ts` (Google
Geocoding API; STUB near Amersfoort when no GOOGLE_MAPS_API_KEY, so testable),
`geocodeResponses()` in sweeps (now part of /tick): ok / not_found / ambiguous /
error(transient-retry), far-than-GEOCODE_REVIEW_KM(75) flagged as ambiguous.
Fix-queue UI `/admin/adressen`: correct address → re-queue, or "toch gebruiken"
(manual_override, routes as-is). APPLIED + verified: sweep ok+not_found, fix-loop
(correct→re-queue→ok), stub provider. Needs GOOGLE_MAPS_API_KEY for live geocoding.

`db/009_route_clustering.sql` — Phase 4: the address-level clustering refactor.
`route_stops` is now one 30-min GROUP stop per ADDRESS; painters are children
(`route_stop_painters`, unique per plan = each painter visited once). Build
lifecycle RPCs (service_role): `start_route_build` (round closed→routing + fresh
building plan), `finalize_route_build` (plan→ready+current, round→routed),
`fail_route_build`. App: `web/lib/route.ts` — cluster by place_id/coords, pick the
max-coverage visit date per address, nearest-neighbour order from IKEA Vathorst,
wall-clock packing (ochtend before middag, DST-safe), Google Routes API when
GOOGLE_MAPS_API_KEY else a haversine stub, per-day Google Maps deep-link. UI
`/admin/route`: build/rebuild + per-day stops + "gezien" tap (`route_stops.visited_at`).
APPLIED to dev + verified end-to-end (6 painters/5 addresses/3 days): clustering
(2 painters at one address = 1 stop), NN order, chained local times, gezien persist,
rebuild demotes the prior current plan (exactly 1 current). NOTE: a rebuild is a
fresh plan, so it resets "gezien" marks. Needs GOOGLE_MAPS_API_KEY for real
drive-times/distances (stub otherwise).

**CI is the enforcement layer**: `.github/workflows/ci.yml` applies
`db/tests/ci_stubs.sql` → 001 → 002 → 003 → `db/seed_dev.sql` on a fresh
Postgres 16 and runs `db/tests/smoke_test.sql` (executable subset of the
45-scenario matrix: DST reminder, midnight deadline, visit-window bounds,
token-expiry stamping). Every new migration must pass CI before sign-off.

See `docs/backend_design.md` for the full runtime design and 45-scenario test matrix.

## Repo layout
- `web/` — Next.js app (App Router). `/r/[token]` painter form: server component
  calls `get_invite_by_token`; `PainterForm` (client) posts a server action to
  `submit_response`. `lib/supabaseAdmin.ts` = server-only admin client (the
  service_role key never reaches the browser via `import "server-only"`). Env in
  `web/.env.local` (gitignored). Run: `npm --prefix web run dev` (port 3100).
- `db/` — numbered SQL migrations (`001` base, `002` reconciliation, `003` product
  improvements, `004` security hardening, `005` painter RPCs, `006` round dispatch, `007` outbox,
  `008` geocoding, `009` = deferred clustering refactor)
- `db/seed_dev.sql` — synthetic dev data (fake painters, never real numbers)
- `db/tests/` — `ci_stubs.sql` (auth schema/roles for plain Postgres) +
  `smoke_test.sql` (executable invariants)
- `.github/workflows/ci.yml` — applies all migrations + runs smoke tests on PG16
- `docs/` — `bouwbrief.md` (datamodel walkthrough), `backend_design.md` (runtime + correctness)
- `lib/send-guard.ts` — the no-real-sends guardrail (import before every send)
- `.env.example` — config surface (copy to `.env`, never commit `.env`)

## Scheduling — external, not pg_cron (runs on Supabase Free)
Do NOT use `pg_cron` / `pg_net` (a paused Free project would kill them). Instead a
free external scheduler (**Cloudflare Workers Cron Triggers**, `*/15 * * * *`; a
daily trigger for token-expire; weekly for purge) calls authenticated sweep
endpoints (`/tick` etc.) that run the due reminder/deadline/dispatch/build/watchdog
work. These ticks hit the DB, which also keeps the Free project awake (no 7-day
pause). All sweep logic is idempotent + time-based (e.g. close = "any round where
`now() >= deadline_at`"), so a late/missed tick self-heals. Add a Healthchecks.io
dead-man's-switch so a dead scheduler is caught before the 7-day pause. This
OVERRIDES the pg_cron references in `docs/backend_design.md` (the sweep LOGIC is
unchanged; only the trigger layer moves out of the DB). Datamodel is unaffected.

## Provisioning (Chris) — critical path = Meta
Meta Business verification (days) -> dedicated sender number -> lock domain
`bezoek.krofs.nl` -> submit UTILITY templates: **invite, reminder,
location-confirm** (and optionally route-ready, or use e-mail for that one). Supabase on the
**Free** tier is fine (dev + prod = the 2 free projects) given external scheduling
above; the only Free trade-off is no automated backups — mitigate with a weekly
`pg_dump` via the same scheduler, or upgrade the prod project to Pro (~EUR 25/mo)
only at go-live with real PII. New Vercel + GCP projects. Cloudflare account (free)
for the scheduler. Twilio sandbox for dev.
