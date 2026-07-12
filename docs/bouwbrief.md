# Krofs schilderbezoek-planner — datamodel & bouwbrief

_Gegenereerd + adversarieel gereviewd (integriteit · security/AVG · ops). MVP op Supabase + Next.js/Vercel._


## Tabellen


### `organizations`
Tenant boundary. MVP seeds exactly one row (Krofs). Present so painters/rounds/routes can be scoped without a later destructive migration. Carries the working-day window used by routing.

| kolom | type | key | note |
|---|---|---|---|
| `id` | uuid | PK | default gen_random_uuid() |
| `name` | text |  | 'Krofs' |
| `timezone` | text |  | default 'Europe/Amsterdam'; used for local-day math in deadlines and routing |
| `day_start_local` | time |  | default 08:00; seeds route planned_start for each day |
| `dagdeel_split_local` | time |  | default 12:00; ochtend<split<=middag boundary |
| `max_working_minutes` | integer |  | default 480; feasibility threshold to flag oversubscribed days |
| `retention_months` | integer |  | default 12; PII purge window for closed rounds |
| `created_at` | timestamptz |  | default now() |

### `app_admins`
Whitelist of Supabase Auth users allowed to act as beheerder (Kees). Referenced by org-scoped RLS so only approved auth users get access to their own org's rows.

| kolom | type | key | note |
|---|---|---|---|
| `user_id` | uuid | PK | = auth.users.id; ON DELETE CASCADE |
| `org_id` | uuid | FK | -> organizations.id; RLS compares this to each row's org_id |
| `display_name` | text |  | e.g. 'Kees' |
| `created_at` | timestamptz |  | default now() |

### `painters`
The ~50-painter pool. WhatsApp number in E.164 plus explicit opt-in state required before any template send. Supports GDPR anonymisation in place (FKs are RESTRICT/SET NULL, never hard-delete).

| kolom | type | key | note |
|---|---|---|---|
| `id` | uuid | PK | default gen_random_uuid() |
| `org_id` | uuid | FK | -> organizations.id |
| `full_name` | text |  | not null |
| `wa_phone_e164` | text | UK | unique per org; CHECK E.164; nullable after anonymisation |
| `wa_opt_in_status` | wa_opt_in_status |  | enum pending/opted_in/opted_out; default 'pending' |
| `wa_opt_in_at` | timestamptz |  | when opt-in captured |
| `wa_opt_out_at` | timestamptz |  | when opt-out captured |
| `consent_source` | text |  | 'onboarding_form'/'wa_inbound'/'admin' |
| `consent_text_version` | text |  | version string of consent text shown |
| `is_active` | boolean |  | default true; inactive excluded from new rounds |
| `anonymized_at` | timestamptz |  | set when PII scrubbed; row kept for route history integrity |
| `notes` | text |  | admin only |
| `created_at` | timestamptz |  | default now() |
| `updated_at` | timestamptz |  | trigger-maintained |

### `painter_consent_events`
Append-only, auditable consent trail (GDPR/WhatsApp). One row per opt-in/opt-out event with source and link to the proof in message_log. Never purged for the legal retention window.

| kolom | type | key | note |
|---|---|---|---|
| `id` | uuid | PK | default gen_random_uuid() |
| `painter_id` | uuid | FK | -> painters.id ON DELETE CASCADE |
| `org_id` | uuid | FK | -> organizations.id |
| `event` | consent_event |  | enum opt_in/opt_out |
| `source` | text |  | 'onboarding_form'/'wa_inbound'/'admin' |
| `message_log_id` | uuid | FK | -> message_log.id; inbound proof, nullable |
| `occurred_at` | timestamptz |  | default now() |

### `weekrondes`
One planning round. Fixed IKEA Vathorst start, time anchors, and lifecycle status. deadline_at/reminder_at are computed in Europe/Amsterdam local time by trigger; sent_at is locked once the round leaves draft. Always terminates at deadline.

| kolom | type | key | note |
|---|---|---|---|
| `id` | uuid | PK | default gen_random_uuid() |
| `org_id` | uuid | FK | -> organizations.id |
| `label` | text |  | e.g. 'Week 27 2026' |
| `status` | round_status |  | enum draft/sending/collecting/closed/routing/routed/failed; default 'draft' |
| `start_location_label` | text |  | default 'IKEA Vathorst, Amersfoort' |
| `start_lat` | double precision |  | default 52.2478 |
| `start_lng` | double precision |  | default 5.4147 |
| `visit_minutes` | integer |  | default 30; CHECK > 0 |
| `sent_at` | timestamptz |  | set once at 'start weekronde'; locked by trigger afterward |
| `reminder_at` | timestamptz |  | trigger-computed = sent_at + 24h |
| `deadline_at` | timestamptz |  | trigger-computed = local 23:59:59 of (sent_at local date + 5 days), Europe/Amsterdam |
| `visit_week_start` | date |  | trigger-computed local date = day after deadline; lower bound for workday expansion |
| `closed_at` | timestamptz |  | actual close timestamp |
| `routed_at` | timestamptz |  | when route build completed |
| `created_by` | uuid | FK | -> auth.users.id ON DELETE SET NULL; audit provenance survives admin removal |
| `created_at` | timestamptz |  | default now() |
| `updated_at` | timestamptz |  | trigger-maintained |

### `round_invites`
Per-painter participation in a round. Holds a HASH of the unguessable token (plaintext never stored), NOT-NULL expiry set when sent, and single-use invalidation on submit. One row per (round, painter).

| kolom | type | key | note |
|---|---|---|---|
| `id` | uuid | PK | default gen_random_uuid() |
| `round_id` | uuid | FK | -> weekrondes.id ON DELETE CASCADE |
| `painter_id` | uuid | FK | -> painters.id ON DELETE RESTRICT |
| `org_id` | uuid | FK | -> organizations.id; denormalized for RLS/index |
| `token_hash` | text | UK | sha256 hex of the raw 32-byte token; raw token exists only transiently at send; lookup by hash |
| `token_expires_at` | timestamptz |  | NOT NULL once invite_sent_at set; = round deadline_at; Edge Function treats NULL as REJECT (fail-closed) |
| `valid_from` | timestamptz |  | = invite_sent_at; token unusable before send |
| `status` | invite_status |  | enum pending/sent/reminded/responded/expired/opted_out/failed; default 'pending' |
| `invite_sent_at` | timestamptz |  | dag-0 send; set only after confirmed BSP accept |
| `reminder_sent_at` | timestamptz |  | 24h reminder; set once atomically with claim |
| `responded_at` | timestamptz |  | first successful response submission |
| `token_used_at` | timestamptz |  | set on first successful submit; Edge Function rejects reuse (single-use link) |
| `carry_over_from_invite_id` | uuid | FK | -> round_invites.id; links a rolled-over invite to its expired predecessor |
| `created_at` | timestamptz |  | default now() |
| `updated_at` | timestamptz |  | trigger-maintained |

### `invite_responses`
Painter's submitted answer for one invite: address parts + geocode result/status + manual admin override. One row per invite. Only geocode_status='ok' rows become route stops; failures form the admin fix queue.

| kolom | type | key | note |
|---|---|---|---|
| `id` | uuid | PK | default gen_random_uuid() |
| `invite_id` | uuid | UK | -> round_invites.id ON DELETE CASCADE; UNIQUE |
| `round_id` | uuid | FK | -> weekrondes.id; denormalized |
| `org_id` | uuid | FK | -> organizations.id |
| `straat` | text |  | not null |
| `huisnummer` | text |  | text (allows 12A/12-bis); not null |
| `postcode` | text |  | optional; NL normalized upper/no-space in app |
| `plaats` | text |  | not null |
| `raw_address` | text |  | string sent to geocoder (audit) |
| `geocode_status` | geocode_status |  | enum pending/ok/ambiguous/not_found/error; default 'pending' |
| `lat` | double precision |  | CHECK -90..90; both-null-or-both-set with lng; NOT NULL when status='ok'; (0,0) rejected |
| `lng` | double precision |  | CHECK -180..180 |
| `geocode_provider` | text |  | 'google' |
| `geocode_place_id` | text |  | Google place_id |
| `geocode_confidence` | text |  | Google location_type |
| `geocode_attempts` | integer |  | default 0; retry/backoff counter for transient errors |
| `geocoded_at` | timestamptz |  | when resolved |
| `geocode_error` | text |  | last error when status=error |
| `manual_override` | boolean |  | default false; admin corrected lat/lng by hand -> treated as routable |
| `admin_corrected_at` | timestamptz |  | when admin fixed the address/coords |
| `is_late` | boolean |  | default false; submitted after deadline in grace path |
| `submitted_at` | timestamptz |  | default now() |
| `updated_at` | timestamptz |  | trigger-maintained |

### `response_workdays`
Normalized concrete dates a painter is present at that address. weekday must equal the ISO weekday of work_date (CHECK); dates must fall inside the round visit window (trigger). This is what routing clusters and spreads across.

| kolom | type | key | note |
|---|---|---|---|
| `id` | uuid | PK | default gen_random_uuid() |
| `response_id` | uuid | FK | -> invite_responses.id ON DELETE CASCADE |
| `round_id` | uuid | FK | -> weekrondes.id; denormalized |
| `work_date` | date |  | concrete local date; UNIQUE (response_id, work_date) |
| `weekday` | smallint |  | 1=Mon..7=Sun ISO; CHECK weekday = isodow(work_date) |
| `created_at` | timestamptz |  | default now() |

### `route_plans`
One current route plan per round (regenerable). A trigger demotes prior plans to is_current=false on insert so rebuild never violates the partial unique index. Build runs as a separate resumable step with a watchdog.

| kolom | type | key | note |
|---|---|---|---|
| `id` | uuid | PK | default gen_random_uuid() |
| `round_id` | uuid | FK | -> weekrondes.id ON DELETE CASCADE |
| `org_id` | uuid | FK | -> organizations.id |
| `status` | route_status |  | enum pending/building/ready/failed; default 'pending' |
| `build_started_at` | timestamptz |  | set when status->building; watchdog resets stale builds |
| `generated_at` | timestamptz |  | when build finished |
| `provider` | text |  | 'google_routes' |
| `is_current` | boolean |  | default true; trigger-demotes others; partial unique index |
| `unrouted_count` | integer |  | responders excluded (geocode not ok & no override); surfaced to Kees |
| `error` | text |  | last build error |
| `created_at` | timestamptz |  | default now() |

### `route_days`
One row per visit_date in a plan. Each day is an independent IKEA Vathorst round-trip; ochtend+middag are one continuous chain. Stores day totals and a feasibility flag when the day exceeds max working minutes.

| kolom | type | key | note |
|---|---|---|---|
| `id` | uuid | PK | default gen_random_uuid() |
| `route_plan_id` | uuid | FK | -> route_plans.id ON DELETE CASCADE |
| `round_id` | uuid | FK | -> weekrondes.id; denormalized |
| `visit_date` | date | UK | UNIQUE (route_plan_id, visit_date) |
| `start_lat` | double precision |  | IKEA Vathorst; copied for immutability |
| `start_lng` | double precision |  | IKEA Vathorst |
| `stop_count` | integer |  | trigger-maintained = count(route_stops) |
| `total_distance_m` | integer |  | from Routes API |
| `total_duration_s` | integer |  | drive time excl. visits |
| `is_oversubscribed` | boolean |  | default false; true when drive+visits exceed org.max_working_minutes |
| `google_maps_url` | text |  | per-day 'open in Google Maps' deep link |
| `created_at` | timestamptz |  | default now() |

### `route_stops`
Ordered visits within a route_day. Each stop = one painter visit; fixed visit_minutes slot. Overlap forbidden (EXCLUDE), seq matches planned_start order, dagdeel derived from local time, ochtend precedes middag.

| kolom | type | key | note |
|---|---|---|---|
| `id` | uuid | PK | default gen_random_uuid() |
| `route_day_id` | uuid | FK | -> route_days.id ON DELETE CASCADE |
| `route_plan_id` | uuid | FK | -> route_plans.id; denormalized |
| `response_id` | uuid | FK | -> invite_responses.id ON DELETE RESTRICT (must be geocode_status='ok' or override) |
| `painter_id` | uuid | FK | -> painters.id ON DELETE RESTRICT; denormalized for display |
| `seq` | integer |  | 1-based; UNIQUE (route_day_id, seq); CHECK >=1 |
| `dagdeel` | dagdeel |  | enum ochtend/middag; derived from planned_start local time |
| `planned_start` | timestamptz |  | slot start |
| `planned_end` | timestamptz |  | = planned_start + visit_minutes; CHECK > planned_start |
| `lat` | double precision |  | snapshot at build; NOT NULL |
| `lng` | double precision |  | snapshot at build; NOT NULL |
| `leg_distance_m` | integer |  | from previous point |
| `leg_duration_s` | integer |  | drive time from previous point |
| `created_at` | timestamptz |  | default now() |

### `message_log`
WhatsApp send + inbound log. idempotency_key is mandatory for outbound invite/reminder (partial constraint) so a retried cron never double-sends. payload is redacted (never contains the token/URL). Status advances monotonically; callbacks deduped.

| kolom | type | key | note |
|---|---|---|---|
| `id` | uuid | PK | default gen_random_uuid() |
| `org_id` | uuid | FK | -> organizations.id |
| `painter_id` | uuid | FK | -> painters.id ON DELETE SET NULL |
| `invite_id` | uuid | FK | -> round_invites.id ON DELETE SET NULL |
| `direction` | message_direction |  | enum outbound/inbound |
| `kind` | message_kind |  | enum invite/reminder/opt_in/opt_out/status_callback/other |
| `idempotency_key` | text | UK | UNIQUE; NOT NULL for outbound invite/reminder (partial CHECK); e.g. 'invite:{invite_id}' |
| `provider` | text |  | 'twilio'/'360dialog'/'meta' |
| `provider_message_id` | text |  | BSP message id; used for callback correlation/upsert |
| `template_name` | text |  | approved WA template used |
| `to_phone_e164` | text |  | destination |
| `status` | message_status |  | enum queued/sent/delivered/read/failed/received; monotonic advance only |
| `error_code` | text |  | BSP error code on failure |
| `payload` | jsonb |  | REDACTED audit: template vars keys + callback metadata; MUST NOT contain token or link |
| `created_at` | timestamptz |  | default now() |
| `updated_at` | timestamptz |  | trigger-maintained on callbacks |

## Enums

- `wa_opt_in_status`: pending, opted_in, opted_out
- `consent_event`: opt_in, opt_out
- `round_status`: draft, sending, collecting, closed, routing, routed, failed
- `invite_status`: pending, sent, reminded, responded, expired, opted_out, failed
- `geocode_status`: pending, ok, ambiguous, not_found, error
- `route_status`: pending, building, ready, failed
- `dagdeel`: ochtend, middag
- `message_direction`: outbound, inbound
- `message_kind`: invite, reminder, opt_in, opt_out, status_callback, other
- `message_status`: queued, sent, delivered, read, failed, received

## RLS & toegang

- Two access identities only. (1) Beheerder 'Kees' = a Supabase Auth user whose (auth.uid(), org_id) exists in app_admins; (2) Schilder = NO auth identity at all, only an unguessable token whose HASH is stored.
- Admin RLS is ORG-SCOPED, not global. Every policy uses is_admin_of(<row.org_id>) (SECURITY DEFINER helper comparing app_admins.org_id to the row's org_id). Child tables without org_id (response_workdays/route_days/route_stops) gate via a parent join. This makes the multi-tenant claim true today: a second org cannot read the first org's PII. anon has zero policies, so the public/anon key reads nothing.
- Painter token security: only sha256(token) is stored in round_invites.token_hash; the raw token exists transiently at send time (in the WhatsApp body) and is NEVER persisted in the DB. message_log.payload is redacted and must never contain the token or the /r/{token} URL. The token is single-use (token_used_at) and fail-closed on expiry: the Edge Function rejects when token_expires_at IS NULL, when now() >= token_expires_at, when now() < valid_from, or when token_used_at is already set.
- Painter access path with defense-in-depth: /r/{token} is served by a Next.js server route that calls a Supabase Edge Function (service_role). Because service_role bypasses RLS, painter reads/writes go through SECURITY DEFINER RPCs that look up by token_hash and return ONLY that invite's own fields (never SELECT *, never filter by round_id). A regression test must assert one token cannot retrieve another invite's data.
- Deadlines are DB-authoritative and DST-safe: reminder_at/deadline_at/visit_week_start are trigger-computed from sent_at in Europe/Amsterdam (deadline = local 23:59:59 five local days after send). sent_at is immutable once the round leaves draft (trigger raises), so the reminder and the hard deadline cannot silently drift.
- Messaging least-privilege + idempotency: dispatch/reminder crons run as service_role. The send path is ordered: (1) atomically CLAIM the invite (UPDATE ... WHERE reminder_sent_at IS NULL RETURNING) so only one worker wins; (2) INSERT message_log with idempotency_key ON CONFLICT DO NOTHING (partial CHECK forces the key for outbound invite/reminder) — abort if zero rows; (3) THEN call the BSP; (4) update status/provider_message_id from the response. A DB guard blocks any outbound invite/reminder to a painter whose wa_opt_in_status='opted_out'.
- Public webhook surface (must be enumerated): the BSP delivery-status webhook and the inbound-message/opt-out webhook are PUBLIC Edge Functions (no Supabase Auth). Both MUST verify the provider signature (Twilio X-Twilio-Signature / Meta X-Hub-Signature-256 / 360dialog), advance message_log.status monotonically only (never regress read->sent), and dedupe redelivered callbacks via the unique index on provider_message_id (upsert-by-id, tolerate callback-before-own-row race).
- Secrets & trust paths: SERVICE_ROLE, Google Maps/Geocoding key, and BSP credentials live only in Edge Function / server env, never in the browser bundle. The Next.js server route holds its own shared secret (Vercel env) to call the Edge Function; the cron pg_net call passes the service-role key from Supabase Vault in the Authorization header, and every dispatch/build/webhook function rejects unauthenticated calls. The browser only ever uses the anon key, which (given RLS) can access nothing.
- Consent is evidential: painter_consent_events is an append-only trail (opt_in/opt_out, source, message_log_id, occurred_at) so 'consent valid at send time' and 'opt-out honoured at T' are reconstructable independent of message_log purges. GDPR erasure uses anonymize_painter() (scrubs PII, keeps rows) because painter FKs are RESTRICT/SET NULL to preserve route-history integrity.

## Cron jobs

- **send-reminders** (`*/15 * * * *`): pg_cron -> Edge Function 'dispatch-reminders' (service_role). Selects round_invites where round.status='collecting', now() >= round.reminder_at, reminder_sent_at IS NULL, status='sent', painter.wa_opt_in_status='opted_in', AND a confirmed dag-0 send exists in message_log (status in sent/delivered/read). Per invite: atomically CLAIM (UPDATE ... SET reminder_sent_at=now(), status='reminded' WHERE reminder_sent_at IS NULL RETURNING) so only one worker wins; INSERT message_log key 'reminder:{invite_id}' ON CONFLICT DO NOTHING (abort if zero rows); THEN send BSP template; update status/provider_message_id. Responders (status='responded', set atomically with the response write) are skipped.
- **close-round** (`*/15 * * * *`): pg_cron -> Edge Function 'close-round' (service_role). For every weekronde with status='collecting' and now() >= deadline_at: set status='closed', closed_at=now(); mark still-pending/sent/reminded invites 'expired'. Fast + synchronous. Then INSERT a route_plans row (status='pending') to hand the build to the separate worker. Purely time-based; always terminates regardless of response count.
- **build-routes** (`*/5 * * * *`): pg_cron -> Edge Function 'build-routes' (service_role), resumable/idempotent. Picks the current route_plan with status='pending' (or 'building' older than the watchdog TTL), sets status='building', build_started_at=now(). Re-geocode responses stuck 'pending' (retry transient errors with backoff via geocode_attempts). Cluster ok/override responses per address; expand response_workdays; for each visit_date call Google Routes (origin=destination=IKEA Vathorst, intermediates=lat/lng, optimizeWaypointOrder=true, travelMode=DRIVE). Seed planned_start at org.day_start_local, derive dagdeel from org.dagdeel_split_local, assign visit_minutes slots. Flag route_days.is_oversubscribed when drive+visits > org.max_working_minutes. Write route_days/route_stops + per-day Maps deep link; set unrouted_count (responders excluded). On success plan status='ready', weekronde status='routed', routed_at=now(); on error status='failed' with message.
- **watchdog-stale-builds** (`*/10 * * * *`): pg_cron SQL: reset route_plans stuck in status='building' with build_started_at older than a TTL (e.g. 10 min) back to 'pending' so a killed/timed-out Edge Function build is retried rather than lost.
- **expire-tokens** (`0 3 * * *`): pg_cron -> Edge Function 'expire-tokens' (MANDATORY, not optional): mark round_invites.status='expired' where token_expires_at < now() and status not in ('responded','opted_out','expired'). Belt-and-braces alongside the request-time fail-closed check.
- **purge-pii** (`0 4 * * 0`): pg_cron -> Edge Function 'purge-pii' (data minimisation). For rounds closed/routed longer than organizations.retention_months: delete invite_responses + response_workdays for those rounds and null message_log.payload/to_phone_e164; keep painter_consent_events. Enforces GDPR storage limitation.

## Integraties

- **WhatsApp Business API via BSP** — Automatic per-painter invite (dag 0) + single 24h reminder to non-responders; capture opt-in/opt-out inbound; delivery-status callbacks.
  - Twilio / 360dialog / Meta Cloud API with pre-approved TEMPLATE messages for business-initiated sends. GO-LIVE GATE: dag-0 sends are BLOCKED until opt-in exists — bootstrap opt-in OUTSIDE WhatsApp (onboarding form/portal writing wa_opt_in_at + consent_source) or via a first permitted utility template whose affirmative reply flips pending->opted_in through the inbound webhook. At 'start weekronde' compute and DISPLAY eligible-vs-skipped counts and log a message_log row (kind='other', status='failed', reason 'no_opt_in') per skipped painter. All outbound invite/reminder rows carry idempotency_key (partial CHECK enforces it). Delivery webhook: verify signature, advance status monotonically, dedupe by unique provider_message_id, upsert to tolerate callback-before-row race. Inbound STOP -> painters.opted_out + wa_opt_out_at + append painter_consent_events. Note new-WABA messaging tier limits (e.g. 250/1000 business-initiated/24h) — 50 is fine now.
- **Google Geocoding API** — Convert submitted address to lat/lng before routing.
  - Called from Edge Function on response submit and re-run in build-routes for 'pending'. Distinguish TRANSIENT (429/OVER_QUERY_LIMIT -> status='error', retry with backoff via geocode_attempts) from TERMINAL (not_found/ambiguous -> needs human). Persist place_id, location_type (confidence), geocoded_at. region=nl bias. ambiguous/not_found/error rows are excluded from auto-routing and surfaced to the beheerder (idx_invite_responses_unroutable); admin can manual_override with corrected lat/lng. Cost at ~50/round is negligible (well within free tier) — no caching needed for MVP.
- **Google Maps Routes API (Directions)** — Waypoint-optimized per-day round-trip from/return to IKEA Vathorst; ordered stops + drive legs + totals.
  - One computeRoutes request per visit_date: origin=destination=IKEA Vathorst, intermediates=that day's lat/lng points (NOT place_id — passing lat/lng keeps the limit at 98 waypoints; place_id drops it to 25), optimizeWaypointOrder=true, travelMode=DRIVE. The <1000km cumulative straight-line rule only bites above 25 stops (irrelevant for a compact NL day, but keep a defensive guard). Map optimized order into route_stops.seq; ochtend+middag are one continuous chain per day; each new day restarts from IKEA. Build a per-day Google Maps deep link.
- **Supabase Auth** — Authenticate the single beheerder (Kees).
  - Email magic-link or password; (auth.uid(), org_id) must exist in app_admins for org-scoped admin RLS. Painters never authenticate.
- **Vercel (Next.js)** — Host the admin dashboard and the tokenized painter form page /r/{token}; also the public BSP webhooks (or host webhooks as Supabase Edge Functions).
  - Painter page is server-rendered and talks only to the Edge Function using a server-held shared secret (Vercel env). No service_role/Google/BSP key ever reaches the browser bundle (only NEXT_PUBLIC anon key, which has no table access). Enumerate the full public surface: /r/{token}, delivery-status webhook, inbound-message webhook — each with its auth (shared secret or provider signature).

## Bouwfasen


### 0 - Foundations
- Create Supabase project + apply migration_sql
- Enable extensions: pgcrypto, btree_gist, pg_cron, pg_net
- Seed one organization (Krofs) with timezone/day-window defaults + insert Kees into app_admins
- Set env/secrets in Supabase Vault + Vercel: SERVICE_ROLE, Google Maps key, BSP creds, Next<->EdgeFunction shared secret
- Scaffold Next.js on Vercel with Supabase Auth for admin

### 1 - Painter data + opt-in bootstrap
- Admin CRUD for painters incl. E.164 + opt-in capture writing wa_opt_in_at/consent_source and a painter_consent_events row
- Implement the opt-in bootstrap flow (onboarding form or first utility template) — this is a go-live gate
- Create weekronde (draft) with fixed IKEA Vathorst start + 30-min visit (anchors auto-computed on send)
- Generate round_invites storing token_hash only; build tokenized painter form /r/{token} backed by a SECURITY DEFINER RPC (validate hash, expiry fail-closed, valid_from, single-use)

### 2 - Sending + reminders (WhatsApp)
- Integrate BSP template send; 'start weekronde' sets sent_at (locked), token_expires_at=deadline_at, dispatches dag-0 invites
- Implement the ordered claim->insert(idempotency)->send->update path; block sends to opted_out painters
- Wire the signature-verified delivery-status webhook with monotonic status + provider_message_id dedupe
- Implement send-reminders cron (24h, once, gated on confirmed delivery) + inbound STOP opt-out handling

### 3 - Responses + geocoding
- Response RPC: persist invite_responses (set status='responded' + responded_at atomically) + set token_used_at
- Normalize werkdagen into response_workdays concrete dates (Europe/Amsterdam, within visit window)
- Call Google Geocoding with transient/terminal handling + backoff; store status/place_id/confidence
- Admin fix queue for ambiguous/not_found/error with manual_override + corrected lat/lng

### 4 - Close + routing
- close-round cron: time-based close at deadline (expire non-responders), enqueue route_plan pending
- build-routes worker (resumable, watchdog-guarded): cluster ok/override, expand per work_date
- Per-day Google Routes call from/to IKEA Vathorst (lat/lng waypoints, optimizeWaypointOrder, DRIVE)
- Write route_plans/route_days/route_stops with seq, dagdeel, slots; set is_oversubscribed + unrouted_count; per-day Maps deep links

### 5 - Admin route UI + compliance polish
- Dashboard: round status, eligible-vs-skipped, response counts, per-day routes with ordered stops/times, oversubscribed + unrouted warnings
- 'Open in Google Maps' buttons
- Late reactions: grace-window submit flagged is_late / carry_over_from_invite_id to roll into next round
- Mandatory expire-tokens + purge-pii crons; observability: cron run status, failed sends, geocode failures

## Open risico's

- Weekday->concrete-date expansion: work_date must be >= weekrondes.visit_week_start (day after the local deadline) and its ISO weekday must equal the stored weekday (both now enforced by CHECK + trigger). Confirm with Kees the exact visit-week definition and the rule when a chosen weekday could map to more than one date in the window.
- Daily capacity is computed but not hard-capped: route_days.is_oversubscribed flags days where drive+visits exceed org.max_working_minutes, surfaced to Kees. There is deliberately no auto-balancing (anti-starvation/aging remains out of scope/future); a single oversubscribed day still needs a manual decision.
- Opt-in bootstrap is a hard external dependency: without a compliant opt-in captured OUTSIDE WhatsApp (or via a permitted first template), dag-0 template sends are blocked by the BSP and the round collects nothing while still closing at deadline. The eligible-vs-skipped surfacing mitigates silent failure but the bootstrap itself must exist before go-live.
- Token in URL remains the sole painter credential even with hashing/expiry/single-use: enforce HTTPS-only and no token logging anywhere (message_log.payload is redacted by design; add a test asserting the token substring never appears). A forwarded link before first submit is still a one-time capability until token_used_at is set.
- Edge Function over-fetch is the main no-login risk: service_role bypasses RLS, so the SECURITY DEFINER painter RPCs must filter strictly by the token's own invite_id (never round_id) and never SELECT *. A regression test asserting cross-invite isolation is required.
- Google Routes waypoint handling: keep passing lat/lng (98-waypoint limit) not place_id (25-waypoint limit); the <1000km cumulative straight-line rule only matters above 25 stops. Compact NL days are fine, but keep the defensive per-day guard.
- Long route builds can exceed Edge Function time limits: build-routes runs as a separate resumable step with a watchdog that resets stale status='building' plans; verify the watchdog TTL vs typical build time so a multi-day round is never left permanently stuck.
- BSP status callbacks arrive out of order and are redelivered: rely on monotonic status advancement + unique(provider_message_id) upsert and signature verification; callbacks may arrive before your own message_log row (upsert-by-id handles the race).
- GDPR retention/erasure: purge-pii and anonymize_painter() exist, but confirm the lawful basis and retention_months with the business and document the processing record; addresses reveal client job sites and are sensitive location data.

## Migratie
Zie `krofs_datamodel.sql` (volledige Postgres/Supabase DDL: enums, tabellen, FKs, indexes, RLS, triggers).
