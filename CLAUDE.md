# Krofs schilderbezoek-planner — working agreement

Read this first. It encodes the guardrails and locked decisions for this project.
If an instruction contradicts something here, **stop and surface it** rather than
proceeding.

## What this is
A tool for Krofs' relatiebeheerder (Ruben) to plan physical visits to ~50
gedetacheerde schilders at changing client work-locations. Ruben starts a weekly
round; the app WhatsApps each painter a no-login link; the painter submits their
work address + which days they're there; after a hard deadline the app clusters
per address and builds a per-day driving route from a fixed start
(IKEA Vathorst, Amersfoort).

Stack: Supabase (Postgres + Auth + Edge Functions [Deno] + pg_cron + pg_net +
Vault) + Next.js on Vercel. WhatsApp via Meta Cloud API direct (Twilio sandbox
for dev).

Status: **pre-build**. Schema + backend design authored (see `docs/`). Next code
step: the reconciliation migration (`db/002`) — see "Known drift".

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
IKEA -> Ruben drives ("open in Google Maps"). Late responders roll into the next
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

## De-scoped (do NOT build for MVP)
Clients/inleners; opt-in bootstrap / consent capture (painters seeded opted_in);
GDPR/AVG lawful-basis flows; the old 50% gate; anti-starvation/aging; native apps;
drag-reorder + per-stop done-status on the dashboard.

## Known drift — fix before time/route code
The base schema (`db/001`) was generated before the reminder/deadline/grace
decisions and before the backend design's concurrency columns. The reconciliation
migration (`db/002`, not yet written) must:
1. `reminder_at` -> next-day-same-wall-time (not `+24h`).
2. `deadline_at` -> next-local-midnight of day 5, compare `now() < deadline_at`.
3. Remove the grace / `is_late` path (keep `carry_over_from_invite_id` only as the
   next-round re-invite link).
4. Add missing columns: `route_plans.build_epoch/heartbeat_at/last_completed_visit_date`,
   `route_days.optimization_status`, `invite_responses.geocode_leased_until`,
   `round_invites.send_attempts`.
5. Add `visit_week_end` + upper-bound in `workday_in_window`.
6. Address-level clustering / capacity counts addresses, not painters.

See `docs/backend_design.md` for the full runtime design and 45-scenario test matrix.

## Repo layout
- `db/` — numbered SQL migrations (`001_initial_schema.sql` = base, `002` = reconciliation, ...)
- `docs/` — `bouwbrief.md` (datamodel walkthrough), `backend_design.md` (runtime + correctness)
- `lib/send-guard.ts` — the no-real-sends guardrail (import before every send)
- `.env.example` — config surface (copy to `.env`, never commit `.env`)

## Provisioning (Chris) — critical path = Meta
Meta Business verification (days) -> dedicated sender number -> lock domain
`bezoek.krofs.nl` -> submit UTILITY invite + reminder templates. New Supabase
project on **Pro** (Free auto-pauses and kills cron). New Vercel + GCP projects.
Twilio sandbox for dev.
