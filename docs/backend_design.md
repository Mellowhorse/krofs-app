# Krofs schilderbezoek-planner — backend runtime & correctheidsontwerp

_Adversarieel gereviewd (concurrency/atomiciteit · betrouwbaarheid integraties · security/tijd). Supabase (Postgres + Edge Functions + pg_cron + pg_net + Vault) + Next.js/Vercel._


## Architectuur in het kort

Runtime backend for the Krofs schilderbezoek-planner on Supabase (Postgres + Auth + Edge Functions/Deno + pg_cron + pg_net + Vault) with a Next.js/Vercel front. Three trust identities: (1) beheerder Kees = Supabase Auth user gated by org-scoped RLS via is_admin_of(org_id); (2) schilder = NO auth identity, only an unguessable raw token whose sha256 hash lives in round_invites.token_hash (UNIQUE), reached exclusively through SECURITY DEFINER RPCs executed by a least-privilege painter_gateway DB role (NOT service_role); (3) machine callers = pg_cron/pg_net and BSP webhooks, authorized by a Vault-held service-role bearer or a verified provider signature over raw request bytes. The datamodel already exists; this design specifies the code that drives it and the invariants that keep it provably correct.

Correctness rests on a small set of repeated primitives. (a) The DB is the single source of truth for time: reminder_at/deadline_at/visit_week_start/visit_week_end are trigger-computed from an immutable sent_at using Europe/Amsterdam local-day math ('AT TIME ZONE tz'), so DST cannot silently shift the deadline; deadline_at day-0 semantics are pinned (send day = day 0, comparison against next-midnight to avoid a 23:59:59 gap). (b) Every business-initiated WhatsApp send is a TRANSACTIONAL OUTBOX, not an inline ordered call: phase 1 CLAIM + INSERT message_log(status='queued', idempotency_key) commits; phase 2 (after commit, no DB lock held across the network) calls the BSP passing idempotency_key as the provider client-dedup/reference token, then UPDATEs status/provider_message_id. A dispatch sweeper re-drives rows stuck in 'queued'/'send_error' (safe because the provider dedupes on the reference), converting the path from at-most-once-with-lost-sends to at-least-once-with-provider-dedup — the real meaning of 'exactly-once-ish'. No round_invites row lock is ever held across a BSP HTTP call. (c) Painter token access is fail-closed (reject on NULL expiry, now()>=expiry, now()<valid_from, token used, opted_out) evaluated at load and again inside the write transaction, and cross-tenant/cross-token-safe because RPCs key strictly on the UNIQUE token_hash with SELECT ... INTO STRICT and return only that one invite's own fields. (d) Idempotent/resumable workers (start fan-out, close-round, build-routes) plus a heartbeat watchdog and time-based crons guarantee every round terminates at deadline regardless of response count; build-routes checkpoints per visit_date so large plans complete across ticks and never livelock. (e) Webhooks verify the provider signature over raw bytes, correlate on the echoed idempotency reference (not solely provider_message_id), advance message_log.status via a single atomic INSERT ... ON CONFLICT DO UPDATE with a rank guard in SQL, and model 'failed' as an orthogonal terminal that always wins over in-flight non-read states and triggers remediation. Secrets (service_role, Google keys, BSP creds, Next<->Edge shared secret) live only in Edge/server env + Vault; the browser holds only the anon key, inert under RLS.


## Componenten


### Next.js server routes

#### `Next.js /r/{token} server route`
- Trigger: HTTPS GET/POST from the painter's browser
- Doet: Server-render the tokenized form; proxy to painter-invite-rpc-gateway with the server-held shared secret; per-IP/per-token rate-limit.
- Contract: GET renders form (with visit window) or opaque 410; POST validates input then forwards. Only NEXT_PUBLIC anon key reaches the client (inert under RLS).
- Correctheid: Token stays server-side; never logged. HTTPS-only. Basic rate-limiting mitigates the unauthenticated token endpoint. All authority is the Edge Function + RPCs under the least-privilege role.

#### `Next.js /api/admin/* server routes`
- Trigger: Authenticated admin dashboard actions
- Doet: Broker admin actions: read via Supabase client under admin RLS; privileged mutations (start-weekronde, manual_override, force resend) proxied to Edge Functions with the shared secret.
- Contract: Requires a valid Supabase Auth session whose user is in app_admins. out: dashboard data / action results.
- Correctheid: Reads flow through RLS (is_admin_of) so org isolation holds; the only privileged escalation is behind the shared-secret Edge call, keeping service_role out of the browser.


### Edge Functions

#### `start-weekronde`
- Trigger: HTTP POST from Next.js admin server route (shared secret) when Kees clicks 'Start weekronde'
- Doet: FAST + TRANSACTIONAL ONLY: transition round draft->sending, stamp immutable sent_at (triggers compute reminder_at/deadline_at/visit_week_start/visit_week_end), and INSERT one round_invites row per eligible painter (status='pending', token_hash + token_expires_at=deadline_at + valid_from=now) in ONE transaction. Does NOT send any WhatsApp in-loop. Logs message_log(kind='other',status='failed',error_code='no_opt_in') per skipped painter. Returns eligible/skipped counts.
- Contract: in:{round_id, org_id, actor_user_id}. Requires actor is admin_of(org_id) OR valid service-secret. Pre: round.status='draft'; one-active-round partial unique idx blocks a concurrent second start. out:{sent_at, deadline_at, reminder_at, visit_week_start, visit_week_end, eligible_count, skipped_count, invites_created}. Fail-closed on missing shared secret / non-admin.
- Correctheid: Round transition + full invite fan-out row creation are ONE atomic fact, decoupled from dispatch so a crash cannot leave un-invited painters uninvitable (fix for partial-dispatch-on-crash). UPDATE weekrondes SET status='sending', sent_at=now() WHERE id=$r AND status='draft' RETURNING => zero rows aborts. Raw 32-byte token via gen_random_bytes; sha256 stored (token_hash UNIQUE); raw never persisted/logged. unique(round_id,painter_id) makes re-run a no-op. Actual sends are performed by the resumable dispatch-invite sweeper.

#### `dispatch-invite (resumable sweeper)`
- Trigger: pg_cron 'dispatch-invites' every 1-2 min via pg_net (Vault bearer); also directly re-runnable per invite
- Doet: Drain unsent dag-0 invites for sending rounds and re-drive stuck outbox rows, one invite at a time, via the transactional outbox send path.
- Contract: scans round_invites WHERE round in ('sending','collecting') AND invite_sent_at IS NULL AND painter opted_in AND send_attempts<max. out:{sent, skipped, retried, dead_lettered}. Idempotency key='invite:{invite_id}'.
- Correctheid: Phase 1 (tx, commit): CLAIM UPDATE round_invites SET invite_sent_at=now(), status='sent', valid_from=now(), token_expires_at=round.deadline_at WHERE id=$1 AND invite_sent_at IS NULL AND EXISTS(painter opted_in) RETURNING (zero rows => already sent/ineligible, abort); INSERT message_log(idempotency_key='invite:{invite_id}', kind='invite', direction='outbound', status='queued') ON CONFLICT DO NOTHING; commit. Phase 2 (no lock held): BSP send passing idempotency_key as provider client-ref; on ACK UPDATE status='sent', provider_message_id; on timeout/5xx UPDATE status='send_error', send_attempts++. Sweeper re-drives status IN ('queued','send_error') with backoff; after max attempts sets status='failed' error_code='undispatchable' and surfaces to admin. Marks round 'collecting' once all invites for the round are past 'pending'. Opt-in re-checked in CLAIM WHERE.

#### `painter-invite-rpc-gateway`
- Trigger: HTTP from Next.js /r/{token} server route (server-held shared secret); GET load, POST submit
- Doet: Sole painter-facing data path. Connects as least-privilege DB role painter_gateway (EXECUTE only on get_invite_by_token + submit_response, NO table privileges) — NOT service_role. Delegates ALL data access to those two SECURITY DEFINER RPCs.
- Contract: GET in:{token} -> out:{painter_display_name, round_label, visit_week_start, visit_week_end, deadline_at, already_responded} or opaque 410. POST in:{token, straat,huisnummer,postcode,plaats, workdays:[date...]} -> out:{ok, geocode_status} or opaque error. Auth: shared secret from Vercel; fail-closed token checks inside RPC.
- Correctheid: service_role blast radius removed: a coding slip in the gateway cannot touch tables (role has no table grants). CI lint forbids .from(<table>) in this module. All fail-closed outcomes collapse to a single opaque 410 to the browser (no unknown/expired/used/before-valid_from/opted_out distinction) to kill the state/timing oracle; granular reason kept server-side for observability. Token never logged; Next route rate-limits per IP/token.

#### `geocode-response`
- Trigger: Best-effort call after a response write; authoritative path is claim-based reprocessing by geocode-retry cron and build-routes
- Doet: Geocode one invite_response via Google Geocoding (region=nl), classify transient vs terminal, persist coords/place_id/confidence/status under an atomic claim.
- Contract: in:{response_id}. out:{geocode_status:'ok'|'ambiguous'|'not_found'|'error'|'error_exhausted', lat?,lng?}. Auth: service_role/internal.
- Correctheid: CLAIM: UPDATE invite_responses SET geocode_status='geocoding', geocode_attempts=geocode_attempts+1, geocode_leased_until=now()+lease WHERE id=$1 AND geocode_status IN ('pending','error') AND (geocode_leased_until IS NULL OR geocode_leased_until<now()) RETURNING => single worker; increment atomic (no lost-update). Transient (429/OVER_QUERY_LIMIT/5xx) -> status='error' + backoff; terminal not_found/ambiguous/ZERO_RESULTS/INVALID_REQUEST -> classified terminal IMMEDIATELY (never retried). Hard cap (5 attempts, backoff 1m/5m/30m/2h/6h): after cap status='error_exhausted' surfaced in admin fix queue (idx_invite_responses_unroutable) — no infinite retry. chk_ok_has_coords forbids status='ok' without real non-(0,0) coords. Inline call is fire-and-forget optimization only.

#### `dispatch-reminders`
- Trigger: pg_cron 'send-reminders' */15 * * * * via pg_net (Vault bearer)
- Doet: Send the single 24h reminder to non-responders of collecting rounds past reminder_at via the transactional outbox path.
- Contract: out:{reminders_sent, skipped, retried}. Selects invites where round.status='collecting' AND now()>=reminder_at AND reminder_sent_at IS NULL AND status='sent' AND painter opted_in AND a confirmed dag-0 send exists (message_log kind='invite' status IN sent/delivered/read).
- Correctheid: Phase 1 CLAIM: UPDATE round_invites SET reminder_sent_at=now(), status='reminded' WHERE id=$1 AND reminder_sent_at IS NULL AND status='sent' AND token_used_at IS NULL AND EXISTS(painter opted_in) RETURNING — the status='sent' + token_used_at IS NULL + opted_in predicates are IN THE CLAIM (not just a pre-SELECT), so a concurrent submit_response (status->'responded') or a just-landed opt-out makes the claim match zero rows: no reminder, no status clobber. INSERT message_log key='reminder:{invite_id}' ON CONFLICT DO NOTHING; commit. Phase 2: BSP send with client-ref, then UPDATE. Sweeper re-drives 'queued'/'send_error'. A status-ordering guard trigger forbids 'responded'->'reminded' regression.

#### `close-round`
- Trigger: pg_cron 'close-round' */15 * * * * via pg_net (Vault bearer)
- Doet: Time-based hard close: for every collecting round past deadline_at, take FOR UPDATE on the weekronde, set status='closed'+closed_at, expire still-open invites, enqueue exactly one route_plans(status='pending').
- Contract: out:{rounds_closed, invites_expired, plans_enqueued}. Idempotent.
- Correctheid: Purely time-based (now()>=deadline_at) => always terminates regardless of response count. SELECT ... FOR UPDATE on each weekronde serializes against submit_response's on-time/late decision. UPDATE weekrondes SET status='closed' WHERE status='collecting' AND now()>=deadline_at (conditional => idempotent). Mark invites status='expired' WHERE status IN (pending,sent,reminded). Enqueue via INSERT route_plans ... ON CONFLICT DO NOTHING against a partial unique index UNIQUE(round_id) WHERE status IN ('pending','building','ready') — the check-then-insert race is impossible at the storage layer. Heavy work deferred to build-routes.

#### `build-routes`
- Trigger: pg_cron 'build-routes' */5 * * * * via pg_net (Vault bearer)
- Doet: Resumable, checkpointed, fenced per-round route builder: claim a plan with a fencing token, build day-by-day with a per-visit_date cursor, cap work per invocation, re-enqueue for the rest, and complete only if still the owner.
- Contract: out:{plan_id, status:'building'|'ready'|'failed', days_built_this_run, cursor, unrouted_count}. Auth: service_role.
- Correctheid: CLAIM with fencing: UPDATE route_plans SET status='building', build_epoch=build_epoch+1, build_started_at=now(), heartbeat_at=now() WHERE id=(current status='pending' OR status='building' AND heartbeat_at<now()-HEARTBEAT_TTL) RETURNING build_epoch AS my_epoch => single winner. Reads only SETTLED geocode rows (geocode_status='ok' OR manual_override); geocoding is done by geocode-retry cron, not inline (keeps wall-clock bounded). Per visit_date: one computeRoutes call, origin=destination=IKEA Vathorst 52.2478/5.4147, intermediates=lat/lng (NOT place_id), optimizeWaypointOrder=true, DRIVE; on 429/5xx retry with backoff (Retry-After); on persistent failure for that day emit a fallback ordering (nearest-neighbour haversine from origin) with route_days.optimization_status='fallback' rather than failing the whole plan. If a day's stop count exceeds the optimize-order cap, split into legs and stitch. EVERY route_days/route_stops write and the completion write assert WHERE route_plans.build_epoch=my_epoch (fencing) so a superseded/stolen builder's writes are rejected — no two live builders corrupt one plan. Checkpoint: persist last_completed_visit_date after each day; process at most N days/run then return (status stays 'building', progress preserved) so large plans finish across ticks and never livelock. build_attempts counter: after M failures mark plan='failed' with reason + alert. On completion UPDATE ... SET status='ready' WHERE status='building' AND build_epoch=my_epoch; weekronde='routed'. route_plans_demote_current + partial unique keep one current plan; EXCLUDE + route_stop_invariants enforce non-overlapping, correctly ordered ochtend-before-middag stops.

#### `bsp-status-webhook`
- Trigger: Public HTTP POST from BSP delivery-status callback; no Supabase Auth
- Doet: Ingest delivery-status callbacks, verify provider signature over RAW bytes, advance message_log.status monotonically via a single atomic upsert, correlate on the echoed idempotency reference.
- Contract: in: provider body + signature header (+ echoed client-ref = idempotency_key). out: 200 after verify (stop retries); 401 on bad signature.
- Correctheid: Capture raw request bytes BEFORE parsing; verify X-Twilio-Signature (over exact reconstructed public URL+sorted params) / X-Hub-Signature-256 (HMAC over raw body) / 360dialog secret; reject unsigned (401, alerted). Correlate by idempotency_key (echoed client-ref) FIRST, provider_message_id second — so a callback arriving before the send-path writes provider_message_id still matches the existing row (fixes stub/split-brain). Single atomic statement: INSERT ... ON CONFLICT (idempotency_key) DO UPDATE SET status=EXCLUDED.status, provider_message_id=COALESCE(message_log.provider_message_id,EXCLUDED.provider_message_id) WHERE status_rank(EXCLUDED.status)>status_rank(message_log.status) OR EXCLUDED.status='failed' -- rank compared in SQL against stored status, never read into app code. Ladder queued<sent<delivered<read; 'failed'/'undelivered' is an ORTHOGONAL terminal that always wins over non-read in-flight states and never resurrects to lower. If a callback truly precedes the outbox INSERT, no-op with 200 (do NOT fabricate a row). Terminal-failed on kind IN('invite','reminder') resets one bounded resend claim OR flags the admin 'undelivered' queue.

#### `bsp-inbound-webhook`
- Trigger: Public HTTP POST from BSP inbound-message callback; no Supabase Auth
- Doet: Ingest inbound WhatsApp messages: capture opt-in affirmations and STOP/opt-out; update painter consent state and append the append-only consent trail.
- Contract: in: provider body (from_phone, text, message_id) + signature. out: 200. Auth: provider signature over raw bytes.
- Correctheid: Verify signature (raw bytes). Match painter by wa_phone_e164 within org; dedupe by unique(provider_message_id). STOP/opt-out -> painters.wa_opt_in_status='opted_out', wa_opt_out_at=now(); affirmative first-template reply -> pending->opted_in, wa_opt_in_at=now(). Always INSERT message_log(direction='inbound') and painter_consent_events(event, source='wa_inbound', message_log_id) for evidential consent. Opt-out immediately narrows send eligibility via the opted_in predicate re-checked inside every send CLAIM (best-effort against an already in-flight send; monitored).

#### `expire-tokens`
- Trigger: pg_cron 'expire-tokens' 0 3 * * * via pg_net
- Doet: Belt-and-braces token expiry.
- Contract: out:{expired_count}. Idempotent.
- Correctheid: UPDATE round_invites SET status='expired' WHERE token_expires_at<now() AND status NOT IN (responded,opted_out,expired). Redundant with request-time fail-closed; mandatory so a never-visited link cannot linger usable.

#### `purge-pii`
- Trigger: pg_cron 'purge-pii' 0 4 * * 0 via pg_net
- Doet: GDPR storage-limitation purge for rounds older than retention_months.
- Contract: out:{rounds_purged}. Idempotent.
- Correctheid: Delete invite_responses + response_workdays; redact message_log free-text payload/to_phone_e164 ONLY — KEEP correlation identifiers (provider_message_id, idempotency_key, painter_id link) so a late delivery/opt-out callback can still correlate. KEEP painter_consent_events (legal audit). Idempotent.


### Postgres RPCs (SECURITY DEFINER)

#### `is_admin_of(target_org uuid)`
- Trigger: Called inside every admin RLS policy (using/with check)
- Doet: Org-scoped admin predicate for multi-tenant safety.
- Contract: in:target_org. out:boolean. SECURITY DEFINER, STABLE, search_path=public.
- Correctheid: True only if (auth.uid(), target_org) in app_admins. Every business-table policy gates on the row's own org_id (child tables via parent join) => a second org cannot read the first org's PII. anon has zero policies.

#### `get_invite_by_token(p_token text)`
- Trigger: Called by painter-invite-rpc-gateway on GET /r/{token}
- Doet: Fail-closed, single-invite token load.
- Contract: in: raw token. out: single row of that invite's own display fields (incl visit_week_start/visit_week_end) or fail-closed. SECURITY DEFINER, search_path=public.
- Correctheid: Computes sha256(p_token); SELECT ... INTO STRICT by token_hash only (relies on UNIQUE(token_hash); a duplicate hash hard-fails closed instead of returning an arbitrary row). NEVER filters by round_id, NEVER SELECT *. Rejects on hash miss, NULL expiry, now()>=expiry, now()<valid_from, token_used_at set, opted_out. Returns exactly one invite's fields => cross-token isolation by construction.

#### `submit_response(p_token text, address parts, workdays date[])`
- Trigger: Called by painter-invite-rpc-gateway on POST /r/{token}
- Doet: Atomically record the painter's response, mark token used + invite responded, expand+validate workdays, decide on-time vs late deterministically.
- Contract: in: token + straat/huisnummer/postcode/plaats + workdays[]. out:{response_id, is_late}. SECURITY DEFINER.
- Correctheid: Re-runs all fail-closed checks INSIDE the tx. SELECT status, deadline_at FROM weekrondes WHERE id=$r FOR SHARE => serializes against close-round's FOR UPDATE; is_late := (now()>=deadline_at OR status<>'collecting'); if now()>=grace_until abort. Single UPDATE round_invites SET token_used_at=now(), status='responded', responded_at=now() WHERE token_hash=$hash AND token_used_at IS NULL RETURNING invite_id (zero rows aborts reuse/race). INSERT invite_responses (unique invite_id); insert response_workdays (chk_weekday_matches: isodow==stored weekday; workday_in_window: visit_week_start<=work_date<=visit_week_end). Atomic: token-used + response + workdays commit together. Late writes set is_late and NEVER flip round status.

#### `anonymize_painter(p_painter uuid)`
- Trigger: Admin GDPR-erasure action
- Doet: Scrub painter PII while keeping rows for route-history FK integrity.
- Contract: in: painter_id. out: void. SECURITY DEFINER.
- Correctheid: Nulls/masks name, phone, notes, addresses, message payloads; sets opted_out + anonymized_at; KEEPS painter_consent_events + correlation ids. FKs RESTRICT/SET NULL so route history stays valid.


### Cron jobs

#### `watchdog-stale-builds`
- Trigger: pg_cron 'watchdog-stale-builds' */2 * * * * (pure SQL)
- Doet: Recover route builds whose heartbeat has gone stale by resetting them to 'pending'.
- Contract: UPDATE route_plans SET status='pending' WHERE status='building' AND heartbeat_at<now()-HEARTBEAT_TTL.
- Correctheid: Keys off HEARTBEAT_TTL (short, e.g. 2-3 min), NOT total build duration: build-routes heartbeats (UPDATE heartbeat_at=now()) each processed day, so a live-but-slow build is never stolen while a dead one is reclaimed fast. Combined with the build_epoch fencing token, a reclaimed plan's stale prior builder can no longer write (its epoch no longer matches), so no two builders corrupt one plan.

#### `dispatch-sweeper (outbox redrive)`
- Trigger: pg_cron 'dispatch-sweeper' */3 * * * * via pg_net (Vault bearer)
- Doet: Re-drive message_log rows stuck in status IN ('queued','send_error') older than N minutes, and dead-letter after max attempts.
- Contract: out:{redriven, dead_lettered}.
- Correctheid: Safe because the BSP call carries the deterministic idempotency_key as the provider client-ref so a re-drive dedupes provider-side (at-least-once + provider-dedup = exactly-once-ish). Turns a claimed-but-unsent row from unreachable into recoverable — the core fix for the transaction-boundary hole. After max attempts sets status='failed' error_code='undispatchable' and alerts.


### DB triggers / guards

#### `weekronde_anchors (trigger)`
- Trigger: BEFORE INSERT/UPDATE on weekrondes
- Doet: Compute DST-safe time anchors and lock sent_at after draft.
- Contract: deadline_at from local-day math with next-midnight-minus-1s at day 5 (send day = day 0); reminder_at per pinned semantics; visit_week_start = local deadline day + 1; visit_week_end = visit_week_start + N. Raises if sent_at changes after draft.
- Correctheid: All local-day boundaries via 'AT TIME ZONE Europe/Amsterdam' so spring-forward/fall-back cannot shift the local deadline. deadline_at = (date_trunc('day', sent_at AT TIME ZONE tz) + interval '5 days' + interval '1 day' - interval '1 second') AT TIME ZONE tz, compared as now() < next-local-midnight to avoid a 1s gap. reminder_at semantics pinned with the business: 'next day same wall time' -> (sent_at AT TIME ZONE tz + interval '1 day') AT TIME ZONE tz (DST-safe); or '24h elapsed' -> sent_at + interval '24 hours' (documented as elapsed, not wall). Immutable sent_at => anchors cannot drift. visit_week_end closes the previously-unbounded workday window.

#### `send-path + route DB guards (triggers/constraints)`
- Trigger: On round_invites/message_log/response_workdays/route_stops/route_plans writes
- Doet: Enforce fail-closed, idempotency, window and route invariants at the storage layer.
- Contract: UNIQUE(round_invites.token_hash); invite_expiry_guard; chk_outbound_needs_key; UNIQUE(message_log.idempotency_key); UNIQUE(message_log.provider_message_id) (nullable); status-ordering guard (no responded->reminded); workday_in_window (visit_week_start<=work_date<=visit_week_end) + chk_weekday_matches; excl_stop_overlap + route_stop_invariants; partial unique UNIQUE(route_plans.round_id) WHERE status IN ('pending','building','ready').
- Correctheid: These make the correctness properties true even if application code is wrong: duplicate token hash, unkeyed business send, out-of-window/wrong-weekday workday, overlapping/mis-ordered stops, double plan enqueue, and status regressions are all rejected by the DB.


## Kritieke flows


### A. Start weekronde -> create invite rows (fan-out decoupled)
_Actors: Kees browser -> Next /api/admin/start -> start-weekronde Edge -> Postgres_

1. 1. Kees clicks Start; Next admin route verifies his Supabase session + app_admins membership and POSTs {round_id, org_id} to start-weekronde with the shared secret.
2. 2. start-weekronde verifies the shared secret (fail-closed) and caller-org match.
3. 3. In ONE transaction: UPDATE weekrondes SET status='sending', sent_at=now() WHERE id=$round AND status='draft' RETURNING (zero rows aborts). weekronde_anchors computes reminder_at, deadline_at (local next-midnight-minus-1s at day 5), visit_week_start, visit_week_end. One-active-round partial unique index blocks a concurrent second start.
4. 4. Still in the same tx: select eligible painters (org, is_active, opted_in) and INSERT one round_invites row each {token_hash=sha256(raw), token_expires_at=deadline_at, valid_from=now, status='pending'} (unique(round_id,painter_id) => re-run no-op); INSERT message_log(kind='other',status='failed',error_code='no_opt_in') per skipped painter. Commit.
5. 5. Return eligible/skipped/created counts. NO WhatsApp sent here.
6. 6. The dispatch-invite sweeper (cron) then drains invites WHERE invite_sent_at IS NULL via the transactional outbox path, each guarded by its own per-invite CLAIM; once all invites are past 'pending' the round is marked 'collecting'.

**Garanties:**
- Round-started is one atomic fact (transition + all invite rows) => a crash never leaves un-invited painters uninvitable; the resumable sweeper finishes fan-out.
- At-most-once dag-0 per painter: per-invite CLAIM + unique idempotency_key + provider client-ref dedup.
- No send to opted_out/pending: eligibility filter + opted_in predicate re-checked in the CLAIM.
- Immutable, DST-safe, bounded time anchors incl. visit_week_end.
- Raw token confidentiality: only sha256 stored (UNIQUE); raw only in the outbound body; payload redacted.
- Exactly one active round per org via partial unique index.

### B. Painter opens /r/{token} -> load + submit -> settled geocode
_Actors: Painter browser -> Next /r/{token} -> painter-invite-rpc-gateway (painter_gateway role) -> get_invite_by_token / submit_response -> geocode path -> Google Geocoding_

1. 1. GET /r/{token} on the Next server route (HTTPS, rate-limited) forwards {token} to the gateway with the shared secret.
2. 2. Gateway (least-privilege role) calls get_invite_by_token: sha256, SELECT ... INTO STRICT by token_hash only. Fail-closed on hash miss/NULL expiry/expired/before valid_from/used/opted_out. Returns ONLY that invite's fields incl visit window.
3. 3. Next renders the form (name, round label, visit_week_start..visit_week_end, deadline) or an OPAQUE 410 (no reason leaked).
4. 4. Painter submits address + werkdagen; POST -> gateway -> submit_response in ONE transaction.
5. 5. submit_response re-checks all fail-closed conditions; SELECT status, deadline_at FROM weekrondes FOR SHARE; is_late := now()>=deadline_at OR status<>'collecting'; abort if now()>=grace_until. Then UPDATE round_invites SET token_used_at=now(), status='responded', responded_at=now() WHERE token_hash=$h AND token_used_at IS NULL RETURNING (zero rows aborts reuse).
6. 6. INSERT invite_responses (unique invite_id); expand werkdagen into response_workdays (chk_weekday_matches + workday_in_window with visit_week_start<=date<=visit_week_end). Commit.
7. 7. Best-effort inline geocode-response; authoritative geocoding is the claim-based geocode-retry cron / build-routes reprocessing. Each geocode is an atomic CLAIM with attempt increment and lease.
8. 8. Return success; terminal/exhausted geocodes land in the admin fix queue.

**Garanties:**
- Single-use link: conditional token_used_at UPDATE => second submit aborts.
- Fail-closed access re-checked inside the write tx; browser sees only an opaque 410.
- Cross-token/cross-tenant isolation: STRICT lookup on UNIQUE token_hash, one invite's own fields, never round_id, never SELECT *; gateway role has no table grants.
- Atomicity: token-used + response + workdays commit together.
- Deterministic on-time vs late: FOR SHARE on weekronde vs close-round's FOR UPDATE closes the boundary window.
- Bounded, valid dates: window + weekday CHECK/trigger reject out-of-window/wrong-weekday dates.
- Geocode integrity: atomic claim (no lost attempt increment, no double API spend), terminal classes never retried, ok implies real coords.

### C. 24h reminder cron
_Actors: pg_cron -> pg_net (Vault bearer) -> dispatch-reminders -> Postgres -> BSP (phase 2) -> dispatch-sweeper_

1. 1. Every 15 min pg_cron calls dispatch-reminders (rejects if unauthenticated).
2. 2. Select candidate invites (round collecting, now()>=reminder_at, reminder_sent_at IS NULL, status='sent', opted_in, confirmed dag-0).
3. 3. Per invite phase-1 CLAIM (tx): UPDATE round_invites SET reminder_sent_at=now(), status='reminded' WHERE id=$1 AND reminder_sent_at IS NULL AND status='sent' AND token_used_at IS NULL AND EXISTS(painter opted_in) RETURNING — zero rows => skip. INSERT message_log 'reminder:{invite_id}' (status='queued') ON CONFLICT DO NOTHING; commit.
4. 4. Phase 2 (no lock held): BSP reminder template with idempotency_key as client-ref; on ACK UPDATE sent+provider_message_id; on timeout/5xx UPDATE 'send_error'.
5. 5. dispatch-sweeper re-drives stuck reminder rows; a submit that lands mid-window flips status='responded' first, so the CLAIM matches zero rows and no reminder is sent and status is not clobbered.

**Garanties:**
- Exactly one reminder per non-responder: reminder_sent_at claim + unique key + provider dedup, across 15-min overlaps and multiple workers.
- No reminder to responders/opted_out: responded/opted_in/token_used checks are IN THE CLAIM WHERE, the true serialization point.
- No lost reminder on transient BSP error: 'send_error' + sweeper re-drive.
- No status regression: status-ordering guard forbids responded->reminded.
- Only after a confirmed dag-0 delivery; DST-safe reminder_at.

### D. Deadline close + enqueue route_plan
_Actors: pg_cron -> pg_net (Vault bearer) -> close-round -> Postgres_

1. 1. Every 15 min close-round selects weekrondes WHERE status='collecting' AND now()>=deadline_at.
2. 2. SELECT ... FOR UPDATE on each such weekronde (serializes vs submit_response's FOR SHARE).
3. 3. UPDATE weekrondes SET status='closed', closed_at=now() (conditional => idempotent).
4. 4. UPDATE round_invites SET status='expired' WHERE round_id=$r AND status IN (pending,sent,reminded).
5. 5. INSERT route_plans(round_id, org_id, status='pending', is_current=true) ON CONFLICT DO NOTHING against partial unique UNIQUE(round_id) WHERE status IN ('pending','building','ready') => at-most-one live plan even under overlapping/manual closes.
6. 6. Return counts; heavy routing deferred to build-routes.

**Garanties:**
- Round always terminates at deadline regardless of response count (purely time-based, idempotent).
- Deterministic on-time/late boundary via FOR UPDATE vs FOR SHARE.
- Non-responders consistently expired.
- At-most-one live route_plan per round enforced at the storage layer (no check-then-insert race).

### E. build-routes worker (checkpointed, fenced, resumable)
_Actors: pg_cron -> pg_net (Vault bearer) -> build-routes -> Postgres -> Google Routes; heartbeat watchdog in parallel; geocode-retry cron feeds settled rows_

1. 1. Every 5 min build-routes CLAIMs a plan with a fencing token: UPDATE route_plans SET status='building', build_epoch=build_epoch+1, build_started_at=now(), heartbeat_at=now() WHERE id=(current pending OR building with heartbeat_at<now()-HEARTBEAT_TTL) RETURNING build_epoch AS my_epoch — single winner.
2. 2. Read SETTLED routable responses only (geocode_status='ok' OR manual_override); geocoding itself is performed by the claim-based geocode-retry cron, keeping build wall-clock bounded.
3. 3. Resume from route_plans.last_completed_visit_date; process at most N visit_dates this run. For each: cluster per address; expand response_workdays into that visit_date's bucket; call Google Routes (origin=destination=IKEA Vathorst, lat/lng intermediates, optimizeWaypointOrder, DRIVE); on 429/5xx retry w/ backoff (Retry-After); on persistent failure emit fallback nearest-neighbour ordering with optimization_status='fallback'; if stops exceed the optimize cap, split into legs and stitch.
4. 4. Write route_days/route_stops with WHERE route_plans.build_epoch=my_epoch (fencing) so a stolen/superseded builder's writes are rejected; seed planned_start at org.day_start_local, chain ochtend then middag across dagdeel_split_local; EXCLUDE + route_stop_invariants enforce non-overlap + ordering; set is_oversubscribed when drive+visits>max_working_minutes.
5. 5. Heartbeat: UPDATE heartbeat_at=now() (and last_completed_visit_date) after each day so the watchdog never steals a live build.
6. 6. If more days remain, return with status still 'building' and progress preserved (re-enqueued by the next tick) — large plans complete across ticks, no livelock. If done: UPDATE ... SET status='ready', unrouted_count=... WHERE status='building' AND build_epoch=my_epoch; weekronde='routed'. After M build_attempts failures mark 'failed' + alert.
7. 7. If killed mid-build, watchdog resets stale 'building' (by heartbeat) to 'pending'; next tick re-claims with a NEW build_epoch, so the dead builder's late writes are fenced out.

**Garanties:**
- Crash-safe/resumable + no livelock: per-day checkpoint + capped work/run + re-enqueue means an oversized plan eventually reaches 'ready'.
- No two live builders corrupt one plan: build_epoch fencing on every write + heartbeat-based (not duration-based) reclaim.
- Watchdog never steals a healthy slow build (heartbeat TTL, short) yet reclaims dead ones fast.
- Rebuild-safe: demote trigger + partial unique keep one current plan.
- No overlapping/mis-ordered stops (EXCLUDE + invariants).
- Google Routes resilience: per-day retry, graceful fallback ordering (flagged), leg-splitting on waypoint overflow — a transient blip never fails the whole round.
- Feasibility surfaced not dropped: is_oversubscribed + unrouted_count + optimization_status.

### F. BSP delivery-status webhook
_Actors: BSP -> bsp-status-webhook (public) -> Postgres_

1. 1. BSP POSTs a status callback with a signature header and the echoed client-ref (=idempotency_key).
2. 2. Function captures RAW bytes, verifies the provider signature over them; 401 on failure (alerted).
3. 3. Single atomic upsert: INSERT ... ON CONFLICT (idempotency_key) DO UPDATE SET status=EXCLUDED.status, provider_message_id=COALESCE(existing,EXCLUDED) WHERE status_rank(EXCLUDED.status)>status_rank(stored) OR EXCLUDED.status='failed'. Rank compared in SQL against stored status.
4. 4. If the callback precedes the outbox INSERT (no row for that idempotency_key yet), no-op with 200 (do NOT fabricate a row).
5. 5. Terminal 'failed'/'undelivered' for kind IN('invite','reminder') opens one bounded resend claim OR flags the admin 'undelivered' queue. Return 200.

**Garanties:**
- Signature-verified over raw bytes: unsigned/forged callbacks rejected.
- Atomic monotonic status: compare-and-set in one SQL statement => no read-then-write race can regress read->sent.
- 'failed' is orthogonal-terminal: a post-accept failure is always recorded (never masked as 'sent') and triggers remediation.
- Idempotent + race-tolerant: correlate on echoed client-ref (idempotency_key) so callback-before-provider_message_id still hits the right single row; redelivery is a no-op; no split-brain second row.
- chk_outbound_needs_key never violated (webhook never inserts an unkeyed outbound stub).

### G. BSP inbound / opt-out webhook
_Actors: Painter WhatsApp -> BSP -> bsp-inbound-webhook (public) -> Postgres_

1. 1. BSP POSTs an inbound message + signature; verify signature over raw bytes (fail-closed).
2. 2. Match painter by wa_phone_e164 within org; dedupe by unique(provider_message_id).
3. 3. STOP/opt-out -> opted_out + wa_opt_out_at; affirmative first-template reply -> pending->opted_in + wa_opt_in_at.
4. 4. Always INSERT message_log(direction='inbound', kind) and painter_consent_events(event, source='wa_inbound', message_log_id).
5. 5. Return 200.

**Garanties:**
- Opt-out narrows eligibility via the opted_in predicate re-checked INSIDE every send CLAIM (best-effort against an already in-flight send; monitored for post-opt-out sends).
- Evidential consent: append-only painter_consent_events reconstructs consent validity independent of message_log purges (identifiers kept).
- Idempotent via provider_message_id dedupe.
- Bootstrap-safe: opt-in captured before any dag-0 template is permitted.

### H. Late-reaction handling (explicit grace boundary)
_Actors: Painter (after deadline) -> Next /r/{token} -> gateway -> submit_response; admin dashboard; next round_

1. 1. token_expires_at = deadline_at governs the fail-closed READ path (GET returns opaque 410 after deadline).
2. 2. submit_response uses a SEPARATE grace_until = deadline_at + grace_interval: if now()<deadline_at -> on-time; if deadline_at<=now()<grace_until -> accept but set is_late=true and DO NOT flip round status; if now()>=grace_until -> abort. This resolves the token_expires_at==deadline_at contradiction (grace is an explicit, bounded window, not a silent bypass).
3. 3. build-routes filters strictly on is_late=false, so a produced route reflects only on-time in-window responses.
4. 4. When Kees starts the NEXT weekronde, a fresh invite is created and linked via round_invites.carry_over_from_invite_id to the expired predecessor, re-inviting the late painter.
5. 5. Consent and address history preserved; the late response never mutates the closed/routed round.

**Garanties:**
- Closed rounds are immutable: late writes cannot reopen or mutate a routed round.
- Grace window is explicit and bounded (grace_interval agreed with Kees), not an undefined bypass of the fail-closed check.
- No data loss: is_late + carry_over_from_invite_id roll the late painter into the next round.
- Deterministic routing: only on-time, in-window responses become stops.


## Correctheids-mechanismen

- **Exactly-once-ish WhatsApp sends despite crashes, timeouts, and cron overlap (fixes the fatal transaction-boundary hole)** — Transactional OUTBOX: phase 1 CLAIM (conditional UPDATE ... RETURNING on invite_sent_at/reminder_sent_at) + INSERT message_log(status='queued', deterministic idempotency_key) COMMIT; phase 2 (no DB lock held) call BSP passing idempotency_key as the provider client-ref, then UPDATE status/provider_message_id. On timeout/5xx set status='send_error' (retryable, NOT terminal). A dispatch-sweeper cron re-drives rows in ('queued','send_error') with backoff and a bounded attempt cap; because the provider dedupes on the client-ref, re-drive is safe. Net: at-least-once + provider-dedup = exactly-once-ish, with NO lost sends and NO row lock across an HTTP call.
- **Double-send when two workers fire the same window** — The CLAIM UPDATE's WHERE (reminder_sent_at IS NULL / invite_sent_at IS NULL) admits only the first worker; UNIQUE(message_log.idempotency_key) is the storage-level second guard; chk_outbound_needs_key forces a key on every outbound invite/reminder.
- **Reminder clobbering a just-submitted response (status regression + wrong send)** — Responder/opt-out/used exclusions live IN the CLAIM UPDATE WHERE (status='sent' AND token_used_at IS NULL AND EXISTS opted_in), the actual serialization point — not merely in a pre-SELECT. A status-ordering guard trigger additionally forbids responded->reminded. So a concurrent submit makes the reminder claim match zero rows.
- **Fail-closed painter token access** — SECURITY DEFINER RPCs reject on token_hash miss, NULL expiry, now()>=expiry, now()<valid_from, token_used_at set, or opted_out — at load and again inside the submit tx. invite_expiry_guard guarantees a sent invite has a non-null expiry. Browser sees only an opaque 410 (no reason oracle).
- **Cross-token / cross-tenant leakage and service_role blast radius** — UNIQUE(token_hash) + SELECT ... INTO STRICT means a duplicate/ambiguous hash hard-fails closed, never returns a wrong row. RPCs key strictly on the hash and return one invite's own fields (never round_id, never SELECT *). The gateway connects as a least-privilege painter_gateway role with EXECUTE only on the two RPCs and NO table privileges (service_role kept off the internet-facing path); CI lint forbids .from(table) there. Admin path is org-scoped via is_admin_of; anon has zero policies.
- **Single-use link** — submit_response does UPDATE ... SET token_used_at=now() WHERE token_used_at IS NULL RETURNING in the same tx as the response insert; a second submit gets zero rows and aborts atomically.
- **Monotonic, race-tolerant, failure-aware webhook status** — One atomic statement: INSERT ... ON CONFLICT (idempotency_key) DO UPDATE SET status=EXCLUDED.status WHERE status_rank(EXCLUDED.status)>status_rank(message_log.status) OR EXCLUDED.status='failed'. Rank compared in SQL against the stored status. 'failed'/'undelivered' is orthogonal-terminal and always wins over in-flight non-read states. Correlate on the echoed client-ref (=idempotency_key) so a callback-before-provider_message_id still updates the one existing row; a truly early callback is a 200 no-op, never a fabricated stub.
- **Send-ACK / provider_message_id split-brain** — Correlation never depends solely on provider_message_id. The BSP send carries the idempotency_key as a client-ref that the provider echoes on every status callback; the webhook matches on that. If the send path is killed before persisting provider_message_id, the webhook still updates the existing row (and back-fills provider_message_id via COALESCE).
- **DST-safe deadline/reminder/visit-window math** — weekronde_anchors computes all local boundaries with 'AT TIME ZONE Europe/Amsterdam' from an immutable sent_at. deadline_at uses date_trunc + interval days with next-local-midnight comparison (day-0 = send day; no 23:59:59 gap). reminder_at semantics are pinned with the business (wall-time-next-day computed via double AT TIME ZONE, or documented elapsed-24h). visit_week_end bounds the window.
- **weekday -> concrete-date expansion within a BOUNDED window** — workday_in_window enforces visit_week_start <= work_date <= visit_week_end (visit_week_end added in weekronde_anchors), closing the previously-unbounded future-date hole; chk_weekday_matches enforces weekday==extract(isodow). The app only offers dates inside [visit_week_start, visit_week_end].
- **Geocode transient vs terminal with a hard dead-letter** — Atomic CLAIM (UPDATE ... geocode_attempts+1, lease) so only one worker runs and the increment cannot be lost. 429/OVER_QUERY_LIMIT/5xx -> 'error' + exponential backoff (1m/5m/30m/2h/6h); not_found/ambiguous/ZERO_RESULTS/INVALID_REQUEST -> terminal IMMEDIATELY. After a 5-attempt cap -> 'error_exhausted' surfaced in the admin fix queue (no infinite retry, no quota burn). chk_ok_has_coords forbids ok without real coords. build-routes reads only settled rows.
- **Resumable, non-livelocking, non-re-entrant route builds within Edge wall-clock limits** — build-routes checkpoints last_completed_visit_date per day, caps N days/run, and re-enqueues so oversized plans complete across ticks (no build->timeout->rebuild livelock). A build_epoch fencing token is bumped on claim and asserted on EVERY write and on completion, so a superseded/stolen builder cannot write or mark ready. A short heartbeat_at (updated per day) drives the watchdog, so a live-but-slow build is never reclaimed while a dead one is reclaimed fast. build_attempts cap -> plan='failed' + alert.
- **Route feasibility, slot integrity, and Google Routes resilience** — excl_stop_overlap EXCLUDE forbids overlapping slots; route_stop_invariants enforces seq==time order, ochtend-before-middag, routable-only responses; is_oversubscribed flags over-capacity days. Per-day Routes calls retry on 429/5xx (Retry-After); persistent failure degrades to nearest-neighbour fallback ordering flagged optimization_status='fallback' rather than failing the plan; days exceeding the optimize-order cap are split into legs and stitched.
- **At-most-one live route_plan per round** — Partial unique index UNIQUE(round_id) WHERE status IN ('pending','building','ready') + enqueue via INSERT ... ON CONFLICT DO NOTHING makes the check-then-insert race impossible regardless of overlapping/manual closes; route_plans_demote_current keeps one is_current.
- **Deterministic on-time vs late at the deadline boundary** — submit_response takes FOR SHARE on the weekronde and sets is_late := now()>=deadline_at OR status<>'collecting'; close-round takes FOR UPDATE when flipping to 'closed'. The two serialize, eliminating the in-between window; a distinct grace_until bounds acceptable lateness.
- **Termination guarantee** — close-round is purely time-based and idempotent; build-routes always reaches a terminal plan state (ready via checkpointing, or failed after a bounded attempt cap). A monitor alerts if any round stays 'collecting' past deadline+margin.
- **Cron delivery reliability (pg_net is fire-and-forget)** — Correctness never depends on a single tick landing: every worker is idempotent and self-redriving (dispatch-sweeper for sends, watchdog for builds, time-based re-selection for close/reminders). A follow-up cron inspects net._http_response and re-drives failed pg_net invocations; a run-status monitor alerts on zero progress. Overlap is harmless due to conditional CLAIMs.
- **Secret isolation / least privilege** — service_role, Google/BSP creds and the Next<->Edge shared secret live only in Edge/server env + Vault; crons pass the Vault service-role bearer; the painter path uses the scoped painter_gateway role, not service_role; the browser holds only the anon key, inert under RLS.
- **Consent evidential integrity across purges** — painter_consent_events is append-only and never purged; purge-pii redacts only free-text payload/phone and KEEPS correlation identifiers (provider_message_id, idempotency_key, painter_id link) so a late delivery/opt-out callback can still correlate after purge.
- **Webhook signature correctness across providers** — Capture raw request bytes before any parsing; verify against raw bytes; for Twilio reconstruct the exact public URL (Vercel/Supabase proxy host+proto) and sort params; per-provider unit tests with sample payloads; distinguish signature-failure (401, alert) from parse-failure; monitor verification-failure rate and inbound opt-out lag.

## Faalgevallen & afhandeling

- **Crash/timeout between claim and BSP call** → Transactional outbox: claim+queued row committed first; dispatch-sweeper re-drives 'queued'/'send_error' with provider client-ref dedupe; no lost send, no double send. (Replaces the old at-most-once-with-lost-sends boundary.)
- **BSP transient timeout/5xx with no provider_message_id** → status='send_error' (retryable, not terminal); sweeper retries with backoff/cap; correlation later via echoed client-ref if a callback arrives; dead-letter + alert after cap.
- **Send ACK lost before provider_message_id persisted** → Webhook correlates on echoed client-ref (=idempotency_key) and back-fills provider_message_id via COALESCE; no split-brain second row.
- **Cron overlaps / double fire** → Idempotent conditional CLAIMs + unique idempotency_key => duplicate runs are no-ops; at most one send per invite.
- **build-routes killed mid-build** → Heartbeat staleness -> watchdog resets to 'pending'; re-claim bumps build_epoch so the dead builder is fenced out; resume from last_completed_visit_date.
- **Two builders on one plan (slow build passes reclaim window)** → build_epoch fencing on every write + completion; heartbeat-based (not duration-based) reclaim so a live build is never stolen; superseded writes rejected.
- **Plan too large for one Edge invocation** → Per-day checkpoint + N-days/run cap + re-enqueue => completes across ticks; build_attempts cap -> 'failed'+alert; no livelock.
- **Google Routes transient error / quota** → Per-day retry w/ backoff (Retry-After); persistent failure -> nearest-neighbour fallback ordering flagged, not a whole-plan failure; plan='failed' only after bounded attempts, with alert.
- **Day exceeds waypoint/optimize-order limit** → Split the day into legs and stitch; validate against the actual optimize-order cap, not the raw 98 ceiling; flag if oversized.
- **BSP callbacks out of order / redelivered / early** → Single atomic rank-guarded upsert keyed on idempotency_key; 'failed' orthogonal-terminal; early callback = 200 no-op (no stub); redelivery idempotent.
- **Post-accept delivery 'failed'** → Recorded as failed (never masked as 'sent'); bounded resend claim or admin undelivered queue.
- **Geocoding transient outage/quota** → Atomic claim + backoff; terminal classes immediate; 5-attempt cap -> 'error_exhausted' in admin fix queue; unrouted_count reflects exclusions; no infinite retry.
- **Opt-out lands during an in-flight send** → opted_in re-checked inside the CLAIM WHERE blocks not-yet-sent; a send already past claim is an unavoidable narrow window, monitored/alerted; consent trail records the opt-out authoritatively.
- **pg_net/Vault auth misconfig or lost tick** → Privileged functions fail-closed on missing bearer; idempotent self-redrive (sweeper/watchdog/next selection) recovers; monitor flags zero progress; follow-up cron re-drives failed pg_net responses.
- **No opt-in captured before go-live (BSP blocks templates)** → Eligibility skips non-opted-in + logs no_opt_in; start returns skipped counts; opt-in bootstrap channel is a hard go-live gate, surfaced not silent.
- **Zero responses / painter never opens link** → close-round closes on time; build-routes produces an empty 'ready' plan; round terminates; non-responders carried to next round.
- **Token forwarded/leaked pre-use** → Single-use + expiry(=deadline) + HTTPS + opaque 410 + rate-limit + hash-only storage; a forwarded link dies on first submit or at deadline; DB leak yields only hashes.
- **Attempt to mutate sent_at or reopen a closed round** → weekronde_anchors raises on sent_at change after draft; late writes flagged is_late within a bounded grace and never mutate a closed/routed round; carry-over rolls them forward.
- **Second org / anon reads tenant PII; gateway coding slip** → Org-scoped RLS on every table (child via parent join); anon has zero policies; painter path uses least-privilege painter_gateway role (no table grants) so a slip cannot leak; CI lint guard.
- **Duplicate route_plan enqueue** → Partial unique UNIQUE(round_id) WHERE status IN(pending,building,ready) + ON CONFLICT DO NOTHING; demote trigger keeps one current.
- **Overlapping/mis-ordered stops from a buggy build** → excl_stop_overlap EXCLUDE + route_stop_invariants reject at write; the day/plan errors rather than persisting an invalid route.
- **Late webhook after PII purge** → purge keeps correlation identifiers (provider_message_id, idempotency_key, painter link); redacts only free-text payload/phone; late delivery/opt-out still correlates and appends to consent trail.
- **Webhook signature intermittently fails behind a proxy** → Verify over captured raw bytes; reconstruct exact public URL for Twilio; per-provider tests; distinguish signature-failure (401, alert) from parse-failure; monitor false-drop rate to avoid silent missed opt-outs.

## Observability

- Outbox health: count message_log rows in ('queued','send_error') older than N minutes (dispatch-sweeper backlog) and dead-lettered ('failed' error_code='undispatchable'); alert on growth — the primary signal that sends are stalling.
- Cron run status: log each cron/Edge invocation with rows-affected (invites_sent, reminders_sent, rounds_closed, plans_enqueued, days_built_this_run) and duration; inspect net._http_response for failed pg_net calls; alert on zero-progress or repeated failures.
- Failed/undelivered sends dashboard: message_log WHERE direction='outbound' AND status IN ('failed','undelivered') grouped by error_code and round; surface the admin 'undelivered' queue (painters never reachable) and eligible-vs-skipped (no_opt_in) counts.
- Geocode failure queue: idx_invite_responses_unroutable powers the admin fix queue (ambiguous/not_found/error_exhausted with no override); track geocode_attempts distribution and error_exhausted rate to spot quota exhaustion.
- Build health: alert if a plan sits 'building' past HEARTBEAT_TTL repeatedly, if build_attempts approaches the fail cap, or if any plan is 'failed'; expose last_completed_visit_date progress and optimization_status='fallback' day counts.
- Delivery funnel: per round, counts by message status queued/sent/delivered/read/failed and by invite_status; response rate = responded / opted_in.
- Route feasibility flags: surface route_days.is_oversubscribed, optimization_status='fallback', and route_plans.unrouted_count prominently so Kees makes the manual call.
- Webhook health: signature-verification failure rate, out-of-order/regressed callbacks ignored, and inbound opt-out processing lag; alert on spikes (spoofing or provider/proxy change).
- Consent audit view: painter_consent_events timeline per painter for GDPR/WhatsApp reconstruction, intact after PII purges.
- Token-safety CI check: automated grep asserting no raw token / /r/{token} URL appears in message_log.payload or logs; plus a lint forbidding .from(<table>) in the painter gateway module.
- Termination assertion: alert if any weekronde stays status='collecting' after now()>deadline_at+margin (close-round not firing), or if any round never reaches a terminal plan state.

## Testmatrix

| # | scenario | verwacht |
|---|---|---|
| 1 | Crash AFTER outbox commit but BEFORE the BSP call (the boundary hole) | Row is status='queued'; dispatch-sweeper re-drives it (client-ref makes provider dedupe); message is eventually sent exactly once — NOT silently lost. |
| 2 | BSP call times out / returns 5xx | status='send_error', send_attempts++; sweeper retries with backoff; after cap -> status='failed' error_code='undispatchable' + alert; never a permanent silent no-send. |
| 3 | Two dispatch-reminders invocations run the same 15-min window against one invite | Exactly one send; one message_log 'reminder:{invite_id}'; loser gets zero rows on CLAIM and aborts. |
| 4 | Reminder cron races a painter's submit_response on the same invite | CLAIM WHERE status='sent' AND token_used_at IS NULL fails once submit flipped to 'responded'; no reminder sent; status not clobbered (no responded->reminded). |
| 5 | Start-weekronde crashes mid fan-out | Round transition + all invite rows already committed atomically; dispatch-invite sweeper finishes sending the unsent invites; no painter permanently uninvited. |
| 6 | Start-weekronde called twice concurrently for one draft round | One transitions draft->sending (RETURNING one row); the other aborts; one active round only (partial unique index). |
| 7 | Delivery callback arrives BEFORE provider_message_id is persisted | Webhook correlates on echoed client-ref (idempotency_key), updates the existing row (back-fills provider_message_id); no second/stub row; no chk_outbound_needs_key violation. |
| 8 | Webhook redelivery: same status 3x | First advances; subsequent are no-ops via the atomic rank-guarded upsert; no duplicate rows. |
| 9 | Out-of-order webhook: 'read' then late 'sent' | Stays 'read'; lower-rank 'sent' ignored by the SQL rank guard. |
| 10 | Post-accept failure: queued->sent then later 'failed' | 'failed' (orthogonal terminal) wins over 'sent'; recorded as failed; remediation (bounded resend or admin undelivered queue) triggered — not masked as 'sent'. |
| 11 | Two concurrent build-routes on one plan (real build exceeds reclaim window) | Only the current build_epoch owner's writes land; the superseded builder's writes and its completion UPDATE are fenced out (WHERE build_epoch=my_epoch); no interleaved/corrupt plan. |
| 12 | build-routes killed mid-build | heartbeat goes stale; watchdog resets to 'pending'; next tick re-claims with a new build_epoch; dead builder's late writes rejected; build resumes from last_completed_visit_date. |
| 13 | Oversized plan too big for one Edge invocation | Per-day checkpoint + N-days/run cap + re-enqueue => plan progresses each tick and eventually reaches 'ready'; no build->timeout->rebuild livelock; after M attempts -> 'failed'+alert. |
| 14 | Google Routes 429/5xx on one visit_date | Per-day retry with backoff (Retry-After); on persistent failure that day gets nearest-neighbour fallback ordering flagged optimization_status='fallback'; whole plan NOT failed. |
| 15 | A visit_date with more stops than the optimize-order cap | Day split into legs and stitched; no API waypoint error; day still produced. |
| 16 | Token reuse: valid submit then same token POSTed again | First sets token_used_at + responded; second gets zero rows on conditional UPDATE, rejected; no second invite_responses (unique invite_id). |
| 17 | Duplicate token_hash (bug/carry-over) queried | SELECT ... INTO STRICT hard-fails closed (no arbitrary wrong-row read); UNIQUE(token_hash) prevents the duplicate at write time. |
| 18 | Token GET/POST after deadline (no grace) | Opaque 410; no data returned or written. |
| 19 | Late submit within grace window (deadline<=now<grace_until) | Accepted, is_late=true, round status unchanged; excluded from the current route; carried via carry_over_from_invite_id next round. |
| 20 | Submit exactly at the deadline boundary vs concurrent close-round | FOR SHARE vs FOR UPDATE serialize: response is either cleanly on-time or deterministically is_late; no ambiguous in-between. |
| 21 | NULL-expiry token with invite_sent_at set | invite_expiry_guard blocks the write; if forced, RPC rejects on NULL expiry. |
| 22 | Cross-token isolation: token B tries to read/write invite A | RPC returns only invite B's own fields; A never exposed; regression test passes. |
| 23 | Cross-tenant RLS: org2 admin queries org1 data | Zero rows; child tables blocked via parent join. |
| 24 | Gateway coding-slip does .from('painters') | Permission denied (painter_gateway role has no table grants); CI lint also flags it pre-merge. |
| 25 | Anon key direct table access | Zero rows / permission denied everywhere (no anon policies). |
| 26 | Opted-out painter in a new round | No dag-0 send; message_log(kind='other',status='failed',error_code='no_opt_in'); skipped count surfaced. |
| 27 | Inbound STOP after eligibility select but before send | opted_in re-check in the CLAIM WHERE fails the claim if opt-out committed first; a post-opt-out send that still races the external call is monitored/alerted (unavoidable narrow window). |
| 28 | DST spring-forward: round sent evening before change | deadline_at = local next-midnight-minus-1s at day 5 (not shifted +/-1h); reminder_at matches pinned semantics; visit_week_start/end correct. |
| 29 | deadline day-0 boundary: sends at 00:01 and 23:59 local | Identical local deadline date (day-0=send day); no 23:59:59 dead-second issue (next-midnight comparison). |
| 30 | Workday one day past visit_week_end | workday_in_window rejects (upper bound now enforced). |
| 31 | Workday with isodow != stored weekday | chk_weekday_matches rejects. |
| 32 | Geocode transient 429 (concurrent inline + cron) | Atomic CLAIM lets only one worker run; single attempt increment; status='error'; retried with backoff; no double API spend. |
| 33 | Geocode permanently transient at cap | After 5 attempts -> 'error_exhausted' in admin fix queue; no infinite retry / quota burn. |
| 34 | Geocode ZERO_RESULTS / INVALID_REQUEST | Classified terminal immediately (never retried); admin fix queue; manual_override makes routable; unrouted_count reflects it. |
| 35 | geocode_status='ok' written with (0,0)/null coords | chk_ok_has_coords / chk_latlng_pairing rejects. |
| 36 | Oversubscribed day | is_oversubscribed=true; day still built; surfaced; no silent drop. |
| 37 | Overlapping / mis-ordered stops from a buggy build | excl_stop_overlap + route_stop_invariants reject; plan errors rather than persisting an invalid route. |
| 38 | Duplicate route_plan enqueue on overlapping close-round | Partial unique UNIQUE(round_id) WHERE status IN(pending,building,ready) + ON CONFLICT DO NOTHING => single live plan. |
| 39 | Deadline with zero responses | close-round still closes, expires invites, enqueues plan; build-routes produces an empty plan (0 days) status='ready'; round terminates. |
| 40 | pg_net tick lost (function down) | Idempotent self-redrive (sweeper/watchdog/next selection) recovers; run-status monitor alerts on zero progress; correctness unaffected. |
| 41 | Unsigned/forged BSP webhook | 401 (verified over raw bytes), no DB mutation, alerted. |
| 42 | Twilio callback behind proxy (URL rewritten) | Exact public URL reconstructed for signature; verification passes; no false 401 dropping a legit callback. |
| 43 | Late delivery/opt-out callback after purge-pii | Correlation identifiers retained => callback still correlates; consent event still appended; only free-text payload/phone were redacted. |
| 44 | Token endpoint probing / enumeration | All fail-closed outcomes return an identical opaque 410; per-IP/per-token rate-limit throttles probing; granular reason only in server logs. |
| 45 | Token confidentiality: grep message_log.payload and logs for raw token | Never present; payload redacted; only /r/{token} in the outbound template body, never logged. |

## Open vragen

- reminder_at semantics: confirm with Kees whether '24h reminder' means 24h elapsed (sent_at + interval '24 hours') or next-day same-wall-time (DST-safe double AT TIME ZONE). Encode and test the chosen one.
- deadline day-0 convention: confirm the send day counts as day 0 (current assumption) so '5 local days after send' = local next-midnight-minus-1s at day 5; add boundary tests for 00:01 and 23:59 local sends.
- grace_interval for late reactions: pick the concrete value for grace_until = deadline_at + grace_interval (or set it to zero = hard expire at deadline). Drives submit_response's is_late window.
- visit_week_end rule: confirm the window length (Mon-Fri = visit_week_start+4, or +6) and how a chosen weekday mapping to multiple dates in the window is resolved (earliest match vs offer all).
- BSP choice (Twilio vs 360dialog vs Meta Cloud): locks the exact signature scheme, the client-ref/echo field used for correlation, and template-approval details; the two webhook functions branch on provider until then.
- Opt-in bootstrap channel: onboarding form/portal vs first permitted utility template whose reply flips pending->opted_in. Hard go-live gate.
- HEARTBEAT_TTL and per-run day-cap (N) for build-routes, and geocode backoff/cap constants: tune empirically against measured Edge wall-clock and Google latency (proposed HEARTBEAT_TTL 2-3 min, 5 geocode attempts).
- Oversubscription remains advisory (no auto-balancing/aging) and fallback-ordered days are flagged not auto-fixed: confirm Kees accepts making the manual call for the MVP.
- GDPR lawful basis and retention_months: confirm and document the processing record (client-site addresses are sensitive) before finalizing purge-pii settings; confirm which identifiers must be retained for consent/correlation.
- Dispatch-sweeper max-attempts before dead-letter, and the admin remediation UX for 'undispatchable'/'undelivered' painters: define before go-live.