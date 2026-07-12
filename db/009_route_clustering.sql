-- ============================================================================
-- db/009 — Phase 4 route building: ADDRESS-LEVEL clustering.
-- ----------------------------------------------------------------------------
-- The deferral tracked since db/002: route_stops becomes one 30-minute GROUP
-- stop per ADDRESS (not per painter). Painters at the same address become
-- CHILDREN of the stop (route_stop_painters). Capacity/oversubscription now
-- counts addresses. Each painter is visited exactly once per plan.
--
-- No real data exists yet (dev/synthetic only), so route_stops is dropped and
-- recreated rather than migrated in place.
--
-- Also adds the build lifecycle RPCs (start/finalize/fail) so a route build is
-- an atomic, resumable, service_role-only transition closed -> routing -> routed.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Rebuild route_stops as address-level, drop the per-painter shape.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_route_stop_invariants on route_stops;
drop trigger if exists trg_route_day_count on route_stops;
drop table if exists route_stops cascade;

create table route_stops (
  id             uuid primary key default gen_random_uuid(),
  route_day_id   uuid not null references route_days(id) on delete cascade,
  route_plan_id  uuid not null references route_plans(id) on delete cascade,
  seq            integer not null check (seq >= 1),
  dagdeel        dagdeel not null,
  planned_start  timestamptz not null,
  planned_end    timestamptz not null,
  lat            double precision not null,
  lng            double precision not null,
  cluster_key    text not null,
  straat         text not null,
  huisnummer     text not null,
  postcode       text,
  plaats         text not null,
  painter_count  integer not null default 0 check (painter_count >= 0),
  leg_distance_m integer,
  leg_duration_s integer,
  visited_at     timestamptz,
  created_at     timestamptz not null default now(),
  unique (route_day_id, seq),
  -- one stop per address across the whole plan => each address visited once
  unique (route_plan_id, cluster_key),
  constraint chk_slot_order check (planned_end > planned_start),
  -- no two visits in the same day may overlap in time
  constraint excl_stop_overlap exclude using gist (
    route_day_id with =,
    tstzrange(planned_start, planned_end) with &&
  )
);
create index idx_route_stops_day on route_stops(route_day_id);
create index idx_route_stops_plan on route_stops(route_plan_id);
comment on table route_stops is
  'One 30-min GROUP visit per address per plan. Painters are children (route_stop_painters). visited_at = "gezien" tap.';

-- Painters visited at a stop (children). Uniqueness guarantees one visit per
-- painter per plan even across rebuilds within the same plan.
create table route_stop_painters (
  id            uuid primary key default gen_random_uuid(),
  stop_id       uuid not null references route_stops(id) on delete cascade,
  route_plan_id uuid not null references route_plans(id) on delete cascade,
  response_id   uuid not null references invite_responses(id) on delete restrict,
  painter_id    uuid not null references painters(id) on delete restrict,
  painter_name  text not null,
  created_at    timestamptz not null default now(),
  unique (route_plan_id, response_id),
  unique (route_plan_id, painter_id)
);
create index idx_route_stop_painters_stop on route_stop_painters(stop_id);
create index idx_route_stop_painters_plan on route_stop_painters(route_plan_id);

-- ---------------------------------------------------------------------------
-- 2. Invariants.
-- ---------------------------------------------------------------------------
-- Stop ordering: seq order == time order, ochtend never follows middag.
create or replace function route_stop_invariants()
returns trigger language plpgsql set search_path = public as $$
declare prev record;
begin
  select seq, planned_start, dagdeel into prev
    from route_stops
    where route_day_id = NEW.route_day_id and seq < NEW.seq
    order by seq desc limit 1;
  if prev.seq is not null then
    if NEW.planned_start <= prev.planned_start then
      raise exception 'seq/time ordering violated in route_day % (seq % start % <= prev start %)',
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

-- Child guard: the response must be routable (geocode ok OR admin override) and
-- belong to the same round as the plan.
create or replace function route_stop_painter_check()
returns trigger language plpgsql set search_path = public as $$
declare gs geocode_status; ov boolean; resp_round uuid; plan_round uuid;
begin
  select geocode_status, manual_override, round_id into gs, ov, resp_round
    from invite_responses where id = NEW.response_id;
  if gs <> 'ok' and coalesce(ov, false) = false then
    raise exception 'response % is not routable (geocode_status=%, override=%)', NEW.response_id, gs, ov;
  end if;
  select round_id into plan_round from route_plans where id = NEW.route_plan_id;
  if resp_round is distinct from plan_round then
    raise exception 'response % belongs to a different round than plan %', NEW.response_id, NEW.route_plan_id;
  end if;
  return NEW;
end;
$$;
create trigger trg_route_stop_painter_check before insert on route_stop_painters
  for each row execute function route_stop_painter_check();

-- Keep route_stops.painter_count in sync with its children.
create or replace function route_stop_painter_count()
returns trigger language plpgsql set search_path = public as $$
declare sid uuid;
begin
  sid := coalesce(NEW.stop_id, OLD.stop_id);
  update route_stops s
     set painter_count = (select count(*) from route_stop_painters p where p.stop_id = sid)
   where s.id = sid;
  return null;
end;
$$;
create trigger trg_route_stop_painter_count after insert or delete on route_stop_painters
  for each row execute function route_stop_painter_count();

-- Keep route_days.stop_count in sync (recreated after the table drop).
create or replace function route_day_stop_count()
returns trigger language plpgsql set search_path = public as $$
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

-- ---------------------------------------------------------------------------
-- 3. RLS (service_role bypasses; the admin dashboard reads as authenticated).
-- ---------------------------------------------------------------------------
alter table route_stops         enable row level security;
alter table route_stop_painters enable row level security;

create policy admin_org on route_stops for all to authenticated
  using (exists (select 1 from route_plans p where p.id = route_plan_id and is_admin_of(p.org_id)))
  with check (exists (select 1 from route_plans p where p.id = route_plan_id and is_admin_of(p.org_id)));

create policy admin_org on route_stop_painters for all to authenticated
  using (exists (select 1 from route_plans p where p.id = route_plan_id and is_admin_of(p.org_id)))
  with check (exists (select 1 from route_plans p where p.id = route_plan_id and is_admin_of(p.org_id)));

-- ---------------------------------------------------------------------------
-- 4. Build lifecycle (service_role only).
--    start -> a fresh 'building' plan (is_current=false) + round 'routing'.
--    finalize -> plan 'ready' + is_current=true (demotes prior) + round 'routed'.
--    fail -> plan 'failed' + round 'failed'; any prior current plan is untouched.
-- ---------------------------------------------------------------------------
create or replace function start_route_build(p_round_id uuid, p_provider text default 'stub')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_status round_status; v_plan uuid;
begin
  select org_id, status into v_org, v_status
    from weekrondes where id = p_round_id for update;
  if v_org is null then
    raise exception 'round % not found', p_round_id;
  end if;
  if v_status not in ('closed', 'routing', 'routed', 'failed') then
    raise exception 'round % is not closed yet (status=%)', p_round_id, v_status;
  end if;

  update weekrondes set status = 'routing' where id = p_round_id;

  insert into route_plans (round_id, org_id, status, provider, is_current, build_started_at,
                           build_epoch, build_attempts, heartbeat_at)
  values (p_round_id, v_org, 'building', p_provider, false, now(),
          coalesce((select max(build_epoch) from route_plans where round_id = p_round_id), 0) + 1,
          1, now())
  returning id into v_plan;

  return v_plan;
end;
$$;

create or replace function finalize_route_build(p_plan_id uuid, p_unrouted int default 0)
returns void language plpgsql security definer set search_path = public as $$
declare v_round uuid;
begin
  update route_plans
     set status = 'ready', generated_at = now(), heartbeat_at = now(),
         is_current = true, unrouted_count = p_unrouted, error = null
   where id = p_plan_id
  returning round_id into v_round;
  if v_round is null then
    raise exception 'plan % not found', p_plan_id;
  end if;
  update weekrondes set status = 'routed' where id = v_round;
end;
$$;

create or replace function fail_route_build(p_plan_id uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare v_round uuid;
begin
  update route_plans
     set status = 'failed', is_current = false, error = left(p_error, 500)
   where id = p_plan_id
  returning round_id into v_round;
  if v_round is not null then
    update weekrondes set status = 'failed' where id = v_round;
  end if;
end;
$$;

revoke execute on function start_route_build(uuid, text)  from public, anon, authenticated;
revoke execute on function finalize_route_build(uuid, int) from public, anon, authenticated;
revoke execute on function fail_route_build(uuid, text)    from public, anon, authenticated;
grant  execute on function start_route_build(uuid, text)  to service_role;
grant  execute on function finalize_route_build(uuid, int) to service_role;
grant  execute on function fail_route_build(uuid, text)    to service_role;

comment on function start_route_build(uuid, text) is
  'Phase-4 build claim (service_role): flips a closed/routed round to routing and opens a fresh building plan (is_current=false, bumped build_epoch). Returns the plan id.';
comment on function finalize_route_build(uuid, int) is
  'Phase-4 build commit (service_role): plan -> ready + current (demotes prior), round -> routed.';
comment on function fail_route_build(uuid, text) is
  'Phase-4 build abort (service_role): plan -> failed, round -> failed; any prior current plan stays current.';

commit;
