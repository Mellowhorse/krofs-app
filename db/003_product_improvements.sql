-- ============================================================================
-- Krofs schilderbezoek-planner — db/003 PRODUCT IMPROVEMENTS
-- ----------------------------------------------------------------------------
-- Implements the chat-history review improvements (all approved by Chris):
--   P1  Location freshness: the form asks for the address of the VISIT WEEK
--       (copy-level, no schema) + a day-before LOCATION-CONFIRM ping
--       (new message_kind 'location_confirm' + tracking columns).
--   P2  Visit tracking: route_stops.visited_at ("gezien" tap) + a
--       painter_last_visited view — Ruben's original "bijhouden wie je
--       gezien hebt" ask from the interview.
--   P3  Prefill: one-tap "werk je nog steeds op X?" — no schema change
--       needed, but a painter_last_address view makes the lookup trivial.
--   P4  Inbound fallback: painters who REPLY in WhatsApp instead of using
--       the link — message_log.handled_at + an unhandled-inbound index so
--       the dashboard can surface them to Ruben.
--   P5  deadline_days as an org setting (default 5) instead of hardcoded —
--       the pilot can shorten the window without a migration.
--   P6  route-ready notification to Ruben (message_kind 'route_ready').
--
-- REVIEW BEFORE APPLY. Fresh-DB assumption (like db/002). Idempotent where
-- cheap. Requires db/001 + db/002 applied first.
-- The route_stops ADDRESS-CLUSTERING refactor remains deferred — now db/004.
-- ============================================================================

-- Enum additions must not be used in the same transaction they are added in,
-- so they live OUTSIDE the begin/commit block (each autocommits).
alter type message_kind add value if not exists 'location_confirm';
alter type message_kind add value if not exists 'route_ready';

begin;

-- ============================================================================
-- P5 — deadline_days as org setting (default 5, the locked value)
--   Day-0 convention generalized: round is open days 0..deadline_days and
--   closes at the START of day (deadline_days + 1), local midnight.
--   deadline_days = 5  =>  identical behaviour to db/002 (+6 offset).
-- ============================================================================
alter table organizations
  add column if not exists deadline_days integer not null default 5
  check (deadline_days between 1 and 14);

comment on column organizations.deadline_days is
  'Day-0 convention: round open days 0..deadline_days, closes at start of day (deadline_days+1) local. Default 5 = the locked v3 value.';

-- Rewrite weekronde_anchors to read deadline_days. Carries db/002 semantics
-- unchanged otherwise (R1 wall-time reminder, R2 local-midnight deadline,
-- R3 first Mon–Fri strictly after the deadline, sent_at immutability).
create or replace function weekronde_anchors()
returns trigger language plpgsql as $$
declare
  tz            text;
  dl_days       int;
  deadline_date date;
begin
  -- lock sent_at after draft (unchanged from 001/002)
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
    select o.timezone, o.deadline_days into tz, dl_days
      from organizations o where o.id = NEW.org_id;

    -- reminder = next day, same local wall-time (DST-safe)
    NEW.reminder_at := ((NEW.sent_at at time zone tz) + interval '1 day') at time zone tz;

    -- deadline = start of day (deadline_days+1) local (day-0 convention, hard stop)
    deadline_date   := (NEW.sent_at at time zone tz)::date + dl_days + 1;
    NEW.deadline_at := (deadline_date::timestamp) at time zone tz;

    -- visit window = first Mon–Fri work week strictly after the deadline
    NEW.visit_week_start := deadline_date + (8 - extract(isodow from deadline_date)::int);
    NEW.visit_week_end   := NEW.visit_week_start + 4;
  end if;

  return NEW;
end;
$$;

-- ============================================================================
-- P2 — visit tracking ("gezien" tap on the dashboard)
--   One tap per stop sets visited_at. painter_last_visited gives Ruben the
--   "laatst gezien" column per painter and later enables a priority rule
--   ("wie het langst niet gezien is eerst") with zero schema change.
-- ============================================================================
alter table route_stops
  add column if not exists visited_at timestamptz;

comment on column route_stops.visited_at is
  'Set when Ruben taps "gezien" on the dashboard. Null = planned but not (yet) visited.';

create index if not exists idx_route_stops_painter_visited
  on route_stops(painter_id, visited_at desc)
  where visited_at is not null;

-- security_invoker so RLS of the querying admin applies (PG15+ / Supabase).
create or replace view painter_last_visited
with (security_invoker = true) as
  select painter_id, max(visited_at) as last_visited_at
  from route_stops
  where visited_at is not null
  group by painter_id;

comment on view painter_last_visited is
  '"Laatst gezien" per painter, derived from route_stops.visited_at.';

-- ============================================================================
-- P3 — prefill: latest known address per painter (one-tap confirm on the form)
--   The form shows "Werk je nog steeds op <adres>?" [Ja] [Nee, ander adres].
--   The painter still explicitly confirms for the visit week, so the
--   "fresh per round" guarantee is preserved.
-- ============================================================================
create or replace view painter_last_address
with (security_invoker = true) as
  select distinct on (ri.painter_id)
         ri.painter_id,
         r.straat, r.huisnummer, r.postcode, r.plaats,
         r.lat, r.lng, r.geocode_status,
         r.submitted_at
  from invite_responses r
  join round_invites ri on ri.id = r.invite_id
  order by ri.painter_id, r.submitted_at desc;

comment on view painter_last_address is
  'Most recent submitted address per painter, for the one-tap prefill confirm on /r/{token}.';

-- ============================================================================
-- P1 — day-before location confirmation
--   Reinstates the v1 mitigation for the biggest real-world failure mode
--   (locations change weekly; the visit is 8–13 days after fill-in).
--   The sweep sends a 'location_confirm' template the day before the visit;
--   "ja" sets location_confirmed_at; "nee" (or any free-text reply) lands in
--   the unhandled-inbound queue (P4) for Ruben.
-- ============================================================================
alter table invite_responses
  add column if not exists location_confirm_sent_at timestamptz;
alter table invite_responses
  add column if not exists location_confirmed_at timestamptz;

comment on column invite_responses.location_confirm_sent_at is
  'Day-before "klopt je locatie nog?" ping sent at (sweep-driven, outbox path).';
comment on column invite_responses.location_confirmed_at is
  'Painter confirmed the location for the visit. Null + a nee/free-text reply => Ruben checks the inbound queue.';

-- ============================================================================
-- P4 — inbound fallback queue
--   Painters who reply in WhatsApp instead of tapping the link. The inbound
--   webhook already logs these rows; handled_at lets Ruben dismiss them once
--   processed. Partial index = the dashboard queue.
-- ============================================================================
alter table message_log
  add column if not exists handled_at timestamptz;

comment on column message_log.handled_at is
  'Set when Ruben has processed an inbound message (e.g. manually entered a painter''s address).';

create index if not exists idx_message_log_inbound_unhandled
  on message_log(org_id, created_at)
  where direction = 'inbound' and handled_at is null;

commit;

-- ============================================================================
-- P6 — route-ready notification (documentation)
--   The build-routes sweep, on plan status='ready', queues ONE outbound
--   message_log row kind='route_ready' to Ruben via the same transactional
--   outbox (idempotency_key = 'route_ready:{plan_id}'). Channel = a third
--   UTILITY template, or e-mail if template count should stay at two —
--   decide at Meta template submission. No schema needed beyond the enum.
--
-- DEFERRED —> db/004 (unchanged scope, renumbered from 003):
--   route_stops address-level clustering refactor: one 30-min stop per
--   ADDRESS with painters as a child; capacity/oversubscription counts
--   ADDRESSES, not painters. Affects Phase 4 route building only.
-- ============================================================================
