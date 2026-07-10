-- ============================================================================
-- Krofs schilderbezoek-planner — db/004 SECURITY HARDENING
-- ----------------------------------------------------------------------------
-- Fixes the Supabase security-advisor findings after 001-003:
--   H1  Pin search_path on the 7 trigger/helper functions that lacked it
--       (function_search_path_mutable). Bodies are the LATEST versions
--       (weekronde_anchors from 003; workday_in_window + invite_expiry_guard
--       from 002); only `set search_path = public` is added — no logic change.
--   H2  anonymize_painter (SECURITY DEFINER) was callable by anon/authenticated
--       via /rest/v1/rpc — a public data-erasure hole. Revoke from public,
--       grant to service_role only (backend GDPR path).
--   H3  is_admin_of is a SECURITY DEFINER RLS helper: revoke the blanket PUBLIC
--       grant (so anon can't call it directly) and grant to authenticated
--       (which RLS needs). The remaining "authenticated can execute" advisor
--       note is BY DESIGN (RLS calls it; it only reveals the caller's own
--       admin status) and is accepted.
-- Idempotent: create or replace + revoke/grant are safe to re-run.
-- ============================================================================

begin;

-- ---------- H1: pin search_path (bodies unchanged from latest) ---------------
create or replace function set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end;
$$;

create or replace function weekronde_anchors()
returns trigger language plpgsql set search_path = public as $$
declare
  tz            text;
  dl_days       int;
  deadline_date date;
begin
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

    NEW.reminder_at := ((NEW.sent_at at time zone tz) + interval '1 day') at time zone tz;

    deadline_date   := (NEW.sent_at at time zone tz)::date + dl_days + 1;
    NEW.deadline_at := (deadline_date::timestamp) at time zone tz;

    NEW.visit_week_start := deadline_date + (8 - extract(isodow from deadline_date)::int);
    NEW.visit_week_end   := NEW.visit_week_start + 4;
  end if;

  return NEW;
end;
$$;

create or replace function workday_in_window()
returns trigger language plpgsql set search_path = public as $$
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

create or replace function invite_expiry_guard()
returns trigger language plpgsql set search_path = public as $$
declare
  round_deadline timestamptz;
begin
  if NEW.invite_sent_at is not null then
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

create or replace function route_plans_demote_current()
returns trigger language plpgsql set search_path = public as $$
begin
  if NEW.is_current then
    update route_plans set is_current = false
      where round_id = NEW.round_id and is_current and id <> NEW.id;
  end if;
  return NEW;
end;
$$;

create or replace function route_stop_invariants()
returns trigger language plpgsql set search_path = public as $$
declare gs geocode_status; ov boolean; prev record;
begin
  select geocode_status, manual_override into gs, ov
    from invite_responses where id = NEW.response_id;
  if gs <> 'ok' and coalesce(ov,false) = false then
    raise exception 'route_stop response % is not routable (geocode_status=%, override=%)',
      NEW.response_id, gs, ov;
  end if;
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

-- ---------- H2: lock down anonymize_painter (internal / service_role only) ---
-- Supabase grants EXECUTE to anon/authenticated DIRECTLY (not only via PUBLIC),
-- so revoke from all three explicitly, then re-grant to service_role.
revoke execute on function public.anonymize_painter(uuid) from public, anon, authenticated;
grant  execute on function public.anonymize_painter(uuid) to service_role;

-- ---------- H3: is_admin_of — remove anon, keep authenticated (RLS needs it) --
-- The remaining "authenticated can execute is_admin_of" advisor is BY DESIGN
-- (RLS policies call it under the authenticated role; it only reveals the
-- caller's own admin status) and is accepted.
revoke execute on function public.is_admin_of(uuid) from public, anon;
grant  execute on function public.is_admin_of(uuid) to authenticated;

commit;
