# Krofs schilderbezoek-planner

Weekly visit-planning tool for Krofs' relatiebeheerder: WhatsApp a no-login link
to ~50 painters, collect their work address + days, then build an optimized
per-day driving route from IKEA Vathorst.

**Read [CLAUDE.md](CLAUDE.md) first** — it holds the guardrails and locked
decisions. Nothing gets built that violates it.

## Layout
- `db/` — numbered SQL migrations (`001_initial_schema.sql` = base).
- `docs/` — `bouwbrief.md` (datamodel) and `backend_design.md` (runtime,
  correctness, 45-scenario test matrix).
- `lib/send-guard.ts` — the no-real-sends guardrail; import before every send.
- `.env.example` — config surface. Copy to `.env` (never commit `.env`).

## Status
Pre-build. Schema + backend design done. Next: the reconciliation migration
(`db/002`) to align the schema with the locked decisions (see CLAUDE.md ->
"Known drift").

Stack: Supabase (Postgres, Auth, Edge Functions, pg_cron) + Next.js on Vercel.
WhatsApp via Meta Cloud API (Twilio sandbox in dev).
