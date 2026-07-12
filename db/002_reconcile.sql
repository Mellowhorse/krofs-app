-- ============================================================================
-- Krofs schilderbezoek-planner — db/002 RECONCILIATION migration
-- ----------------------------------------------------------------------------
-- Reconciles the shipped db/001 schema with decisions locked AFTER 001 was
-- generated (see CLAUDE.md "Known drift" + docs/backend_design.md).
--
-- REVIEW BEFORE APPLY. Runs once on a FRESH db (no production data yet).
-- Written to be idempotent / re-runnable where that is cheap:
--   * create or replace function ...           (always safe to re-run)
--   * add column if not exists ...             (safe)
--   * drop column if exists ...                (safe)
--   * create index if not exists ...           (safe)
--   * add constraint guarded by pg_constraint  (safe)
-- Additive over destructive except the single intentional drop in R4
-- (invite_responses.is_late), which is dead under the hard-stop decision.
--
-- Covers: R1 reminder_at, R2 deadline_at (+ token_expires_at consistency),
--         R3 visit window (+visit_week_end, upper bound), R4 drop is_late
--         remnant, R5 concurrency/watchdog/geocode columns + indexes.
-- DEFERRED to db/009 (do NOT do here): the route_stops address-level
--         clustering refactor — see the block at the very bottom.
-- ============================================================================

begin;

-- ============================================================================
-- FRESH-DB GUARD — fail LOUD, do not silently leave stale windows.
--   R3 REDEFINES visit_week_start (and adds visit_week_end). The anchor
--   triggers only fire on INSERT/UPDATE, so any weekronde that ALREADY has
--   sent_at set would keep its old (001) window until the row is touched —
--   and workday_in_window() would then validate against a stale/NULL bound.
--   The brief guarantees a fresh DB (no data). Enforce that assumption here
--   so a mistaken apply against a DB with sent rounds aborts instead of
--   corrupting windows silently. If you INTEND to run this against existing
--   data, remove this guard AND add a backfill:
--     update weekrondes set sent_at = sent_at where sent_at is not null;
--   (re-fires trg_weekronde_anchors to recompute every anchor).
-- ============================================================================
do $$
begin
  if exists (select 1 from weekrondes where sent_at is not null) then
    raise exception
      'db/002 assumes a FRESH db, but weekrondes with sent_at were found. '
      'The R3 visit-window redefinition will not recompute existing rows. '
      'Remove this guard and add a backfill (update weekrondes set sent_at = sent_at where sent_at is not null) if this is intentional.';
  end if;
end
$$;

-- ============================================================================
-- R3 (schema part) — new column visit_week_end
--   The visit window is ONE work week (Mon–Fri) directly after the round
--   closes; the painter form offers those 5 concrete dates. We keep
--   visit_week_start (Monday) and add visit_week_end (Friday = start + 4).
--   Value is trigger-computed below (weekronde_anchors). Additive.
-- ============================================================================
alter table weekrondes
  add column if not exists visit_week_end date;   -- trigger-computed (Friday = visit_week_start + 4)

-- ============================================================================
-- R1 + R2 + R3 (logic) — rewrite weekronde_anchors()
--   Preserves 001's behaviour: null all anchors when sent_at is null; lock
--   sent_at once the round has left 'draft'. Only the anchor MATH changes.
--
--   R1  reminder_at  = NEXT DAY, SAME WALL-TIME (DST-safe), not elapsed +24h.
--         ((sent_at at tz) + interval '1 day') at tz
--       Across a DST boundary this stays at the same local clock time
--       (e.g. 09:00 -> 09:00 next day) instead of drifting by an hour.
--       Fall-back edge: if the next day's local wall-time lands inside the
--       repeated (ambiguous) hour, AT TIME ZONE resolves it to the single
--       standard-offset instant (at most ~1h from nominal) — acceptable for a
--       reminder. (A spring-forward gap cannot occur here: the same local
--       clock time existed on the prior day, so sent_at could hold it.)
--
--   R2  deadline_at  = DAY-0 convention. Send day = day 0. Round is OPEN for
--       days 0..5 inclusive and closes at the START of day 6 = local midnight
--       at the end of day 5. No 23:59:59 gap.
--         deadline_at = ((sent_at at tz)::date + 6)::timestamp at tz
--       App comparison convention (documented, enforced in code, not here):
--         now() <  deadline_at  => round STILL OPEN (collecting)
--         now() >= deadline_at  => round CLOSED (hard stop, no grace)
--       Duration is WALL-CLOCK, not a fixed 144h: a DST transition between
--       send and deadline makes the real elapsed time 143h or 145h BY DESIGN
--       (painters keep their local through-end-of-day-5 window). Do NOT
--       "fix" this into `sent_at + interval '6 days'` — that reintroduces the
--       hour drift this rewrite exists to remove.
--
--   R3  visit_week_start / visit_week_end = the Mon–Fri work week DIRECTLY
--       after the round closes. Anchored off the DEADLINE date (not off the
--       ISO week of close_date) so it is SEND-WEEKDAY-INDEPENDENT:
--         deadline_date    = (sent_at at tz)::date + 6           -- local calendar day the round closes on
--         visit_week_start = deadline_date + (8 - isodow(deadline_date))
--                            -- the FIRST Monday strictly after the deadline
--                            -- (isodow: Mon=1..Sun=7; Mon->+7, ... Sun->+1)
--         visit_week_end   = visit_week_start + 4                -- Friday
--       This is the true "week directly after close" for EVERY send weekday.
--       (The earlier date_trunc('week', close_date)+7 draft was rejected: it
--        jumped the window an extra calendar week for Tue..Sun sends.)
--       This REDEFINES the old visit_week_start (which in 001 was send_date+6).
--       >>> Chris to confirm "first Mon–Fri strictly after the deadline". <<<
-- ============================================================================
create or replace function weekronde_anchors()
returns trigger language plpgsql as $$
declare
  tz            text;
  deadline_date date;
begin
  -- lock sent_at after draft (unchanged from 001)
  if tg_op = 'UPDATE' and OLD.status <> 'draft'
     and NEW.sent_at is distinct from OLD.sent_at then
    raise exception 'sent_at is immutable once a round has left draft';
  end if;

  if NEW.sent_at is null then
    NEW.reminder_at      := null;
    NEW.deadline_at      := null;
    NEW.visit_week_start := null;
    NEW.visit_week_end   := null;
  else
    select o.timezone into tz from organizations o where o.id = NEW.org_id;

    -- R1: reminder = next day, same local wall-time (DST-safe)
    NEW.reminder_at := ((NEW.sent_at at time zone tz) + interval '1 day') at time zone tz;

    -- R2: deadline = start of day 6 = local midnight ending day 5 (day-0 convention)
    deadline_date   := (NEW.sent_at at time zone tz)::date + 6;
    NEW.deadline_at := (deadline_date::timestamp) at time zone tz;

    -- R3: visit window = first Mon–Fri work week strictly after the deadline
    NEW.visit_week_start := deadline_date + (8 - extract(isodow from deadline_date)::int);  -- next Monday after deadline
    NEW.visit_week_end   := NEW.visit_week_start + 4;                                       -- Friday
  end if;

  return NEW;
end;
$$;

-- ============================================================================
-- R3 (logic) — workday_in_window(): enforce BOTH bounds.
--   001 checked only the lower bound (work_date < visit_week_start). Now also
--   reject work_date > visit_week_end. Stays null-safe: if the window is not
--   yet computed (round still draft / not sent), skip the check entirely so
--   inserts are not blocked.
-- ============================================================================
create or replace function workday_in_window()
returns trigger language plpgsql as $$
declare
  vws date;
  vwe date;
begin
  select w.visit_week_start, w.visit_week_end
    into vws, vwe
    from weekrondes w
   where w.id = NEW.round_id;

  if vws is not null and NEW.work_date < vws then
    raise exception 'work_date % is before round visit_week_start %', NEW.work_date, vws;
  end if;
  if vwe is not null and NEW.work_date > vwe then
    raise exception 'work_date % is after round visit_week_end %', NEW.work_date, vwe;
  end if;

  return NEW;
end;
$$;

-- ============================================================================
-- R2 (consistency) — token_expires_at MUST equal the round's deadline_at.
--   001's invite_expiry_guard() only checks token_expires_at is non-null when
--   invite_sent_at is set; it never ties the value to the round deadline. With
--   R2 changing the deadline formula, app code that re-derives token expiry
--   (or carries the OLD day-5 23:59:59 formula, or computes +144h) would
--   expire single-use links ~1 day early and drift by an hour across DST — a
--   painter still inside `now() < deadline_at` could be rejected.
--   Fix: STAMP token_expires_at from weekrondes.deadline_at the moment the
--   invite is first sent, so the two can never diverge regardless of app code.
--   Keeps 001's fail-closed guarantees (non-null expiry, valid_from default).
-- ============================================================================
create or replace function invite_expiry_guard()
returns trigger language plpgsql as $$
declare
  round_deadline timestamptz;
begin
  if NEW.invite_sent_at is not null then
    -- Derive expiry from the round deadline so it can never diverge from R2.
    -- Only stamp on the transition into "sent" (or if still unset) so a later
    -- unrelated UPDATE does not silently re-write an already-set expiry.
    if NEW.token_expires_at is null
       or tg_op = 'INSERT'
       or (tg_op = 'UPDATE' and OLD.invite_sent_at is null) then
      select w.deadline_at into round_deadline
        from weekrondes w where w.id = NEW.round_id;
      if round_deadline is null then
        raise exception
          'cannot send invite %: round % has no deadline_at yet (round not sent)',
          NEW.id, NEW.round_id;
      end if;
      NEW.token_expires_at := round_deadline;
    end if;

    -- Retain 001's fail-closed guarantee (defensive; the branch above sets it).
    if NEW.token_expires_at is null then
      raise exception 'token_expires_at must be set when invite_sent_at is set';
    end if;

    if NEW.valid_from is null then
      NEW.valid_from := NEW.invite_sent_at;
    end if;
  end if;
  return NEW;
end;
$$;

-- ============================================================================
-- R4 — drop the grace / is_late remnant.
--   Under the hard-stop decision there is no "late but accepted" response, so
--   invite_responses.is_late is dead. It is referenced NOWHERE else in 001
--   (no index / constraint / policy), so the drop is clean.
--   Late responders instead roll into the NEXT round via a fresh invite whose
--   carry_over_from_invite_id points back at the prior invite.
-- ============================================================================
alter table invite_responses
  drop column if exists is_late;

-- carry_over_from_invite_id is KEPT, repurposed ONLY as the next-round
-- re-invite link (NOT a late-acceptance mechanism). Document the intent.
comment on column round_invites.carry_over_from_invite_id is
  'Next-round re-invite link: on a fresh round, points at this painter''s prior-round invite whose response arrived after the hard deadline (rolled over). NOT a late-acceptance / grace mechanism — the deadline is a hard stop.';

-- ============================================================================
-- R5 — concurrency / watchdog / geocode columns the backend design needs but
--       001 is missing. All additive with safe defaults.
-- ============================================================================

-- route_plans: build epoch (fences stale async builds), watchdog heartbeat,
-- resumable progress marker, attempt counter.
alter table route_plans
  add column if not exists build_epoch              int         not null default 0,
  add column if not exists heartbeat_at             timestamptz,
  add column if not exists last_completed_visit_date date,
  add column if not exists build_attempts           int         not null default 0;

comment on column route_plans.build_epoch is
  'Monotonic fence for async route builds: a worker writes results only if its epoch still matches the current row (stale/superseded builds are discarded).';
comment on column route_plans.heartbeat_at is
  'Last liveness beat from the active build worker; the watchdog reclaims plans whose heartbeat is stale while status = building.';
comment on column route_plans.last_completed_visit_date is
  'Resume marker: highest visit_date fully built, so a restarted build continues instead of redoing completed days.';
comment on column route_plans.build_attempts is
  'Number of build attempts for this plan (watchdog/retry accounting).';

-- route_days: per-day optimization outcome (routes API success vs fallback vs failed).
alter table route_days
  add column if not exists optimization_status text not null default 'optimized';

-- Add the CHECK separately + idempotently (ADD CONSTRAINT has no IF NOT EXISTS).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_route_days_optimization_status'
      and conrelid = 'route_days'::regclass
  ) then
    alter table route_days
      add constraint chk_route_days_optimization_status
      check (optimization_status in ('optimized','fallback','failed'));
  end if;
end
$$;

-- NOTE on the default: 'optimized' means any route_day inserted BEFORE its
-- optimization result is known reads as a (false) success until the builder
-- overwrites it. The three-value domain is fixed by the backend contract
-- (optimized/fallback/failed), so there is no neutral 'pending' member. The
-- builder MUST set optimization_status explicitly on every insert and never
-- rely on this default as a real outcome.
comment on column route_days.optimization_status is
  'Outcome of this day''s route optimization: optimized (Routes API ok), fallback (heuristic/naive order used), failed (no usable route). Builder MUST set explicitly on insert; the ''optimized'' default is a placeholder, not a real outcome.';

-- invite_responses: geocode work lease (claim/expiry) so concurrent geocode
-- workers don't double-process the same response.
alter table invite_responses
  add column if not exists geocode_leased_until timestamptz;

-- No default / NOT NULL: an unclaimed row reads NULL. The claim query (backend,
-- not this migration) MUST treat geocode_leased_until IS NULL as "claimable"
-- and use `now() < geocode_leased_until` for lease-freshness.
comment on column invite_responses.geocode_leased_until is
  'Lease expiry for the geocode worker that currently owns this row; a claim is valid only while now() < geocode_leased_until. NULL = unclaimed (claimable). Lease-freshness is a query-side filter, not covered by the claim index.';

-- round_invites: send attempt counter (retry accounting for WhatsApp dispatch).
alter table round_invites
  add column if not exists send_attempts int not null default 0;

comment on column round_invites.send_attempts is
  'Number of WhatsApp send attempts for this invite (dispatch retry accounting).';

-- ---------- R5 helpful indexes ----------------------------------------------
-- Watchdog scan: find building plans with a stale/absent heartbeat cheaply.
create index if not exists idx_route_plans_watchdog
  on route_plans (heartbeat_at)
  where status = 'building';

-- Geocode claim queue: unclaimed / lease-expired pending responses per round.
-- Partial WHERE is time-independent (valid for a partial index); the
-- now()-vs-geocode_leased_until freshness test and the IS NULL "unclaimed"
-- case both run in the claim query, so this index only narrows by round_id +
-- pending status. Adequate at ~50-painter scale.
create index if not exists idx_invite_responses_geocode_claim
  on invite_responses (round_id, geocode_leased_until)
  where geocode_status = 'pending';

-- ============================================================================
-- Refresh the function / column comments now that the semantics changed.
-- ============================================================================
comment on function weekronde_anchors() is
  'Computes reminder_at (next-day same wall-time, DST-safe), deadline_at (day-0 convention: local midnight ending day 5; now()>=deadline_at means closed) and the visit window visit_week_start/visit_week_end (first Mon–Fri strictly after the deadline) in org timezone; locks sent_at after draft.';
comment on function workday_in_window() is
  'Rejects work_date outside the round visit window [visit_week_start, visit_week_end]; null-safe (skips when the window is not yet computed).';
comment on function invite_expiry_guard() is
  'On the send transition, stamps token_expires_at := weekrondes.deadline_at so the single-use link expiry can never diverge from the R2 hard deadline; defaults valid_from := invite_sent_at; fail-closed if the round has no deadline.';
comment on column weekrondes.deadline_at is
  'Trigger-computed hard stop (day-0 convention): local midnight at the end of day 5. now() < deadline_at = open; now() >= deadline_at = closed. No 23:59:59 gap, no grace. Duration is wall-clock (143h/145h across a DST transition by design), not a fixed 144h.';
comment on column weekrondes.reminder_at is
  'Trigger-computed: next calendar day at the same local wall-time as sent_at (DST-safe).';
comment on column weekrondes.visit_week_start is
  'Trigger-computed Monday of the first full work week STRICTLY AFTER the deadline (deadline_date + (8 - isodow)). Send-weekday-independent. REDEFINED in db/002 (was send_date+6 in db/001).';
comment on column weekrondes.visit_week_end is
  'Trigger-computed Friday of the visit week (= visit_week_start + 4). Upper bound enforced by workday_in_window().';

commit;

-- ============================================================================
-- DEFERRED to db/009 — DO NOT IMPLEMENT HERE.
-- ----------------------------------------------------------------------------
-- Address-level clustering refactor of route_stops: one 30-minute stop per
-- ADDRESS (not per painter), with painters as a CHILD of the stop, and
-- capacity/oversubscription counting ADDRESSES rather than painters. This only
-- affects Phase 4 route building and is intentionally left out of db/002 to
-- keep this migration a pure reconciliation of time/window/concurrency drift.
-- Track it as db/009. (route_stops today still references response_id +
-- painter_id 1:1 — that stays until 003.)
-- ============================================================================