-- ============================================================================
-- Krofs schilderbezoek-planner — MVP schema (Postgres / Supabase) — CORRECTED
-- All timestamps timestamptz (UTC on the wire). Local-day math uses
-- organizations.timezone = 'Europe/Amsterdam'.
-- deadline_at / reminder_at / visit_week_start are TRIGGER-computed from sent_at
-- (calendar-aware, DST-safe) and sent_at is LOCKED once status leaves 'draft'.
-- Painter token: only a sha256 HASH is stored; raw token lives transiently at
-- send time. Admin RLS is ORG-SCOPED (multi-tenant-safe from day one).
-- ============================================================================

create extension if not exists pgcrypto;    -- gen_random_uuid(), gen_random_bytes(), digest()
create extension if not exists btree_gist;   -- EXCLUDE overlap on (uuid, tstzrange)

-- ---------- enum types -------------------------------------------------------
create type wa_opt_in_status  as enum ('pending','opted_in','opted_out');
create type consent_event     as enum ('opt_in','opt_out');
create type round_status      as enum ('draft','sending','collecting','closed','routing','routed','failed');
create type invite_status     as enum ('pending','sent','reminded','responded','expired','opted_out','failed');
create type geocode_status    as enum ('pending','ok','ambiguous','not_found','error');
create type route_status      as enum ('pending','building','ready','failed');
create type dagdeel           as enum ('ochtend','middag');
create type message_direction as enum ('outbound','inbound');
create type message_kind      as enum ('invite','reminder','opt_in','opt_out','status_callback','other');
create type message_status    as enum ('queued','sent','delivered','read','failed','received');

-- ---------- helpers ----------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

-- ---------- organizations ----------------------------------------------------
create table organizations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  timezone            text not null default 'Europe/Amsterdam',
  day_start_local     time not null default '08:00',
  dagdeel_split_local time not null default '12:00',
  max_working_minutes integer not null default 480 check (max_working_minutes > 0),
  retention_months    integer not null default 12 check (retention_months > 0),
  created_at          timestamptz not null default now()
);

-- ---------- app_admins (beheerder whitelist) --------------------------------
create table app_admins (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  org_id       uuid not null references organizations(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);
create index idx_app_admins_org on app_admins(org_id);

-- ORG-SCOPED admin predicate: true only if caller is an admin OF THAT org.
create or replace function is_admin_of(target_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_admins a
    where a.user_id = auth.uid() and a.org_id = target_org
  );
$$;

-- ---------- painters ---------------------------------------------------------
create table painters (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id) on delete cascade,
  full_name            text not null,
  wa_phone_e164        text check (wa_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  wa_opt_in_status     wa_opt_in_status not null default 'pending',
  wa_opt_in_at         timestamptz,
  wa_opt_out_at        timestamptz,
  consent_source       text,
  consent_text_version text,
  is_active            boolean not null default true,
  anonymized_at        timestamptz,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, wa_phone_e164)
);
create index idx_painters_org_active on painters(org_id, is_active);
create trigger trg_painters_updated before update on painters
  for each row execute function set_updated_at();

-- ---------- painter_consent_events (append-only audit) ----------------------
create table painter_consent_events (
  id             uuid primary key default gen_random_uuid(),
  painter_id     uuid not null references painters(id) on delete cascade,
  org_id         uuid not null references organizations(id) on delete cascade,
  event          consent_event not null,
  source         text,
  message_log_id uuid,               -- FK added after message_log exists
  occurred_at    timestamptz not null default now()
);
create index idx_consent_events_painter on painter_consent_events(painter_id);

-- ---------- weekrondes -------------------------------------------------------
create table weekrondes (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id) on delete cascade,
  label                text,
  status               round_status not null default 'draft',
  start_location_label text not null default 'IKEA Vathorst, Amersfoort',
  start_lat            double precision not null default 52.2478,
  start_lng            double precision not null default 5.4147,
  visit_minutes        integer not null default 30 check (visit_minutes > 0),
  sent_at              timestamptz,
  reminder_at          timestamptz,      -- trigger-computed
  deadline_at          timestamptz,      -- trigger-computed (local 23:59:59, +5 local days)
  visit_week_start     date,             -- trigger-computed (local date after deadline)
  closed_at            timestamptz,
  routed_at            timestamptz,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Compute anchors in org timezone; LOCK sent_at once out of draft.
create or replace function weekronde_anchors()
returns trigger language plpgsql as $$
declare tz text;
begin
  -- lock sent_at after draft
  if tg_op = 'UPDATE' and OLD.status <> 'draft'
     and NEW.sent_at is distinct from OLD.sent_at then
    raise exception 'sent_at is immutable once a round has left draft';
  end if;

  if NEW.sent_at is null then
    NEW.reminder_at := null; NEW.deadline_at := null; NEW.visit_week_start := null;
  else
    select o.timezone into tz from organizations o where o.id = NEW.org_id;
    NEW.reminder_at := NEW.sent_at + interval '24 hours';
    -- deadline = end of the local day that is 5 local days after the send local day
    NEW.deadline_at := ((((NEW.sent_at at time zone tz)::date + 5)::text || ' 23:59:59')::timestamp)
                        at time zone tz;
    NEW.visit_week_start := (NEW.sent_at at time zone tz)::date + 6;  -- day after deadline
  end if;
  return NEW;
end;
$$;
create trigger trg_weekronde_anchors before insert or update on weekrondes
  for each row execute function weekronde_anchors();
create trigger trg_weekrondes_updated before update on weekrondes
  for each row execute function set_updated_at();

create index idx_weekrondes_org_status on weekrondes(org_id, status);
create index idx_weekrondes_deadline   on weekrondes(deadline_at) where status = 'collecting';
create index idx_weekrondes_reminder   on weekrondes(reminder_at) where status = 'collecting';
-- At most ONE active round (sending/collecting) per org.
create unique index idx_weekrondes_one_active on weekrondes(org_id)
  where status in ('sending','collecting');

-- ---------- round_invites (hashed token, no-login) --------------------------
create table round_invites (
  id                        uuid primary key default gen_random_uuid(),
  round_id                  uuid not null references weekrondes(id) on delete cascade,
  painter_id                uuid not null references painters(id) on delete restrict,
  org_id                    uuid not null references organizations(id) on delete cascade,
  token_hash                text not null,     -- sha256 hex of raw token; raw never persisted
  token_expires_at          timestamptz,       -- NOT NULL enforced once sent (trigger)
  valid_from                timestamptz,       -- = invite_sent_at
  status                    invite_status not null default 'pending',
  invite_sent_at            timestamptz,
  reminder_sent_at          timestamptz,
  responded_at              timestamptz,
  token_used_at             timestamptz,
  carry_over_from_invite_id uuid references round_invites(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (token_hash),
  unique (round_id, painter_id)
);
-- Once sent, expiry MUST exist (fail-closed credential).
create or replace function invite_expiry_guard()
returns trigger language plpgsql as $$
begin
  if NEW.invite_sent_at is not null and NEW.token_expires_at is null then
    raise exception 'token_expires_at must be set when invite_sent_at is set';
  end if;
  if NEW.invite_sent_at is not null and NEW.valid_from is null then
    NEW.valid_from := NEW.invite_sent_at;
  end if;
  return NEW;
end;
$$;
create trigger trg_invite_expiry_guard before insert or update on round_invites
  for each row execute function invite_expiry_guard();
create trigger trg_round_invites_updated before update on round_invites
  for each row execute function set_updated_at();
create unique index idx_round_invites_token_hash on round_invites(token_hash);
create index idx_round_invites_round_status on round_invites(round_id, status);
create index idx_round_invites_painter on round_invites(painter_id);

-- ---------- invite_responses (address + geocode) -----------------------------
create table invite_responses (
  id                 uuid primary key default gen_random_uuid(),
  invite_id          uuid not null references round_invites(id) on delete cascade,
  round_id           uuid not null references weekrondes(id) on delete cascade,
  org_id             uuid not null references organizations(id) on delete cascade,
  straat             text not null,
  huisnummer         text not null,
  postcode           text,
  plaats             text not null,
  raw_address        text,
  geocode_status     geocode_status not null default 'pending',
  lat                double precision check (lat is null or (lat between -90 and 90)),
  lng                double precision check (lng is null or (lng between -180 and 180)),
  geocode_provider   text,
  geocode_place_id   text,
  geocode_confidence text,
  geocode_attempts   integer not null default 0,
  geocoded_at        timestamptz,
  geocode_error      text,
  manual_override    boolean not null default false,
  admin_corrected_at timestamptz,
  is_late            boolean not null default false,
  submitted_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (invite_id),
  -- lat/lng must both be null or both set
  constraint chk_latlng_pairing check ((lat is null) = (lng is null)),
  -- ok status requires real coords (and not the (0,0) sentinel)
  constraint chk_ok_has_coords check (
    geocode_status <> 'ok'
    or (lat is not null and lng is not null and not (lat = 0 and lng = 0))
  )
);
create index idx_invite_responses_round on invite_responses(round_id);
create index idx_invite_responses_geostatus on invite_responses(round_id, geocode_status);
create index idx_invite_responses_latlng on invite_responses(lat, lng)
  where geocode_status = 'ok';
-- admin fix queue: responses that cannot auto-route
create index idx_invite_responses_unroutable on invite_responses(round_id)
  where geocode_status <> 'ok' and manual_override = false;
create trigger trg_invite_responses_updated before update on invite_responses
  for each row execute function set_updated_at();

-- ---------- response_workdays (normalized concrete dates) --------------------
create table response_workdays (
  id          uuid primary key default gen_random_uuid(),
  response_id uuid not null references invite_responses(id) on delete cascade,
  round_id    uuid not null references weekrondes(id) on delete cascade,
  work_date   date not null,
  weekday     smallint not null,
  created_at  timestamptz not null default now(),
  unique (response_id, work_date),
  -- weekday column can never disagree with the actual date
  constraint chk_weekday_matches check (weekday = extract(isodow from work_date))
);
-- work_date must fall inside the round's visit window (>= visit_week_start).
create or replace function workday_in_window()
returns trigger language plpgsql as $$
declare vws date;
begin
  select w.visit_week_start into vws from weekrondes w where w.id = NEW.round_id;
  if vws is not null and NEW.work_date < vws then
    raise exception 'work_date % is before round visit_week_start %', NEW.work_date, vws;
  end if;
  return NEW;
end;
$$;
create trigger trg_workday_in_window before insert or update on response_workdays
  for each row execute function workday_in_window();
create index idx_response_workdays_round_date on response_workdays(round_id, work_date);

-- ---------- route_plans ------------------------------------------------------
create table route_plans (
  id               uuid primary key default gen_random_uuid(),
  round_id         uuid not null references weekrondes(id) on delete cascade,
  org_id           uuid not null references organizations(id) on delete cascade,
  status           route_status not null default 'pending',
  build_started_at timestamptz,
  generated_at     timestamptz,
  provider         text default 'google_routes',
  is_current       boolean not null default true,
  unrouted_count   integer not null default 0,
  error            text,
  created_at       timestamptz not null default now()
);
-- Demote any prior current plan for the round BEFORE this row lands.
create or replace function route_plans_demote_current()
returns trigger language plpgsql as $$
begin
  if NEW.is_current then
    update route_plans set is_current = false
      where round_id = NEW.round_id and is_current and id <> NEW.id;
  end if;
  return NEW;
end;
$$;
create trigger trg_route_plans_demote before insert or update of is_current on route_plans
  for each row execute function route_plans_demote_current();
create unique index idx_route_plans_current on route_plans(round_id) where is_current;
create index idx_route_plans_round on route_plans(round_id);

-- ---------- route_days -------------------------------------------------------
create table route_days (
  id               uuid primary key default gen_random_uuid(),
  route_plan_id    uuid not null references route_plans(id) on delete cascade,
  round_id         uuid not null references weekrondes(id) on delete cascade,
  visit_date       date not null,
  start_lat        double precision not null,
  start_lng        double precision not null,
  stop_count       integer not null default 0,
  total_distance_m integer,
  total_duration_s integer,
  is_oversubscribed boolean not null default false,
  google_maps_url  text,
  created_at       timestamptz not null default now(),
  unique (route_plan_id, visit_date)
);
create index idx_route_days_plan on route_days(route_plan_id);

-- ---------- route_stops ------------------------------------------------------
create table route_stops (
  id             uuid primary key default gen_random_uuid(),
  route_day_id   uuid not null references route_days(id) on delete cascade,
  route_plan_id  uuid not null references route_plans(id) on delete cascade,
  response_id    uuid not null references invite_responses(id) on delete restrict,
  painter_id     uuid not null references painters(id) on delete restrict,
  seq            integer not null check (seq >= 1),
  dagdeel        dagdeel not null,
  planned_start  timestamptz not null,
  planned_end    timestamptz not null,
  lat            double precision not null,
  lng            double precision not null,
  leg_distance_m integer,
  leg_duration_s integer,
  created_at     timestamptz not null default now(),
  unique (route_day_id, seq),
  constraint chk_slot_order check (planned_end > planned_start),
  -- no two visits in the same day may overlap in time
  constraint excl_stop_overlap exclude using gist (
    route_day_id with =,
    tstzrange(planned_start, planned_end) with &&
  )
);
create index idx_route_stops_day on route_stops(route_day_id);
create index idx_route_stops_plan on route_stops(route_plan_id);

-- Enforce build invariants: only ok/override responses; seq order == time order;
-- ochtend precedes middag; and keep route_days.stop_count in sync.
create or replace function route_stop_invariants()
returns trigger language plpgsql as $$
declare gs geocode_status; ov boolean; prev record;
begin
  select geocode_status, manual_override into gs, ov
    from invite_responses where id = NEW.response_id;
  if gs <> 'ok' and coalesce(ov,false) = false then
    raise exception 'route_stop response % is not routable (geocode_status=%, override=%)',
      NEW.response_id, gs, ov;
  end if;
  -- seq order must match planned_start order and dagdeel must not regress
  select seq, planned_start, dagdeel into prev
    from route_stops
    where route_day_id = NEW.route_day_id and seq < NEW.seq
    order by seq desc limit 1;
  if prev.seq is not null then
    if NEW.planned_start <= prev.planned_start then
      raise exception 'seq/time ordering violated in route_day % (seq % start % <= prev %)',
        NEW.route_day_id, NEW.seq, NEW.planned_start, prev.planned_start;
    end if;
    if prev.dagdeel = 'middag' and NEW.dagdeel = 'ochtend' then
      raise exception 'ochtend stop cannot follow a middag stop in route_day %', NEW.route_day_id;
    end if;
  end if;
  return NEW;
end;
$$;
create trigger trg_route_stop_invariants before insert or update on route_stops
  for each row execute function route_stop_invariants();

create or replace function route_day_stop_count()
returns trigger language plpgsql as $$
declare did uuid;
begin
  did := coalesce(NEW.route_day_id, OLD.route_day_id);
  update route_days rd
     set stop_count = (select count(*) from route_stops s where s.route_day_id = did)
   where rd.id = did;
  return null;
end;
$$;
create trigger trg_route_day_count after insert or delete on route_stops
  for each row execute function route_day_stop_count();

-- ---------- message_log ------------------------------------------------------
create table message_log (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  painter_id          uuid references painters(id) on delete set null,
  invite_id           uuid references round_invites(id) on delete set null,
  direction           message_direction not null,
  kind                message_kind not null,
  idempotency_key     text,
  provider            text,
  provider_message_id text,
  template_name       text,
  to_phone_e164       text,
  status              message_status not null default 'queued',
  error_code          text,
  payload             jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (idempotency_key),
  -- business-initiated sends MUST carry an idempotency key (double-send guard)
  constraint chk_outbound_needs_key check (
    not (direction = 'outbound' and kind in ('invite','reminder'))
    or idempotency_key is not null
  )
);
create index idx_message_log_invite on message_log(invite_id);
create index idx_message_log_painter on message_log(painter_id);
-- callback correlation + redelivery dedupe (one row per BSP message id)
create unique index idx_message_log_provider_msg on message_log(provider_message_id)
  where provider_message_id is not null;
create trigger trg_message_log_updated before update on message_log
  for each row execute function set_updated_at();

-- deferred FK: consent proof -> message_log
alter table painter_consent_events
  add constraint fk_consent_message_log
  foreign key (message_log_id) references message_log(id) on delete set null;

-- ---------- GDPR: anonymise a painter without breaking route history ---------
create or replace function anonymize_painter(p_painter uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update painters
     set full_name = 'Verwijderd',
         wa_phone_e164 = null,
         notes = null,
         wa_opt_in_status = 'opted_out',
         anonymized_at = now()
   where id = p_painter;
  update invite_responses ir
     set straat = 'x', huisnummer = 'x', postcode = null, plaats = 'x',
         raw_address = null, geocode_place_id = null
   from round_invites ri
   where ir.invite_id = ri.id and ri.painter_id = p_painter;
  update message_log set payload = null, to_phone_e164 = null
   where painter_id = p_painter;
end;
$$;

-- ============================================================================
-- ROW LEVEL SECURITY  (ORG-SCOPED admin; NO anon policies; service_role bypasses)
-- ============================================================================
alter table organizations          enable row level security;
alter table app_admins             enable row level security;
alter table painters               enable row level security;
alter table painter_consent_events enable row level security;
alter table weekrondes             enable row level security;
alter table round_invites          enable row level security;
alter table invite_responses       enable row level security;
alter table response_workdays      enable row level security;
alter table route_plans            enable row level security;
alter table route_days             enable row level security;
alter table route_stops            enable row level security;
alter table message_log            enable row level security;

-- organizations: admin may see/edit only their own org row
create policy admin_org on organizations for all to authenticated
  using (is_admin_of(id)) with check (is_admin_of(id));

-- app_admins: an admin sees only their own membership row
create policy admin_self on app_admins for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- every business table: gate on the row's own org_id
create policy admin_org on painters               for all to authenticated using (is_admin_of(org_id)) with check (is_admin_of(org_id));
create policy admin_org on painter_consent_events for all to authenticated using (is_admin_of(org_id)) with check (is_admin_of(org_id));
create policy admin_org on weekrondes             for all to authenticated using (is_admin_of(org_id)) with check (is_admin_of(org_id));
create policy admin_org on round_invites          for all to authenticated using (is_admin_of(org_id)) with check (is_admin_of(org_id));
create policy admin_org on invite_responses       for all to authenticated using (is_admin_of(org_id)) with check (is_admin_of(org_id));
create policy admin_org on route_plans            for all to authenticated using (is_admin_of(org_id)) with check (is_admin_of(org_id));
create policy admin_org on message_log            for all to authenticated using (is_admin_of(org_id)) with check (is_admin_of(org_id));
-- child tables without org_id: gate via parent join
create policy admin_org on response_workdays for all to authenticated
  using (exists (select 1 from weekrondes w where w.id = round_id and is_admin_of(w.org_id)))
  with check (exists (select 1 from weekrondes w where w.id = round_id and is_admin_of(w.org_id)));
create policy admin_org on route_days for all to authenticated
  using (exists (select 1 from route_plans p where p.id = route_plan_id and is_admin_of(p.org_id)))
  with check (exists (select 1 from route_plans p where p.id = route_plan_id and is_admin_of(p.org_id)));
create policy admin_org on route_stops for all to authenticated
  using (exists (select 1 from route_plans p where p.id = route_plan_id and is_admin_of(p.org_id)))
  with check (exists (select 1 from route_plans p where p.id = route_plan_id and is_admin_of(p.org_id)));
-- NO anon/authenticated-painter policies anywhere. Painter access is exclusively
-- via Edge Functions (service_role bypasses RLS) using SECURITY DEFINER RPCs
-- that filter strictly by the token's own invite_id.

-- ---------- comments ---------------------------------------------------------
comment on function weekronde_anchors() is 'Computes reminder_at/deadline_at/visit_week_start in org timezone; locks sent_at after draft';
comment on column round_invites.token_hash is 'sha256 of the raw token; plaintext token never stored (leak-resistant)';
comment on column round_invites.token_used_at is 'Set on first submit; Edge Function rejects token reuse (single-use link)';
comment on constraint excl_stop_overlap on route_stops is 'No overlapping visit slots within one route_day';
comment on function anonymize_painter(uuid) is 'GDPR erasure: scrubs PII, keeps rows so route history FKs stay intact';