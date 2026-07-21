-- ============================================================================
-- db/012 — Kees kiest zelf de bezoekweek én zijn eigen beschikbare dagen.
-- ----------------------------------------------------------------------------
-- Tot nu toe volgde de bezoekweek dwingend uit het startmoment (eerste hele
-- werkweek na de deadline). Kees wil vandaag een uitvraag kunnen doen voor
-- bijvoorbeeld de laatste week van augustus, en daarbinnen aangeven op welke
-- dagen hij zelf langs kan.
--
-- Twee garanties, in de DB afgedwongen (niet alleen in de UI):
--   1. visit_week_start MOET een maandag zijn en de week loopt t/m vrijdag.
--      De week moet ook NA de deadline beginnen, anders is er geen tijd om te
--      verzamelen en de route te bouwen.
--   2. Een schilder kan geen dag doorgeven waarop Kees niet langskomt.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Kees' beschikbare dagen binnen de bezoekweek (isodow 1=ma .. 5=vr).
-- ---------------------------------------------------------------------------
alter table weekrondes
  add column if not exists visit_weekdays smallint[] not null default '{1,2,3,4,5}';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_visit_weekdays' and conrelid = 'weekrondes'::regclass
  ) then
    alter table weekrondes add constraint chk_visit_weekdays check (
      array_length(visit_weekdays, 1) between 1 and 5
      and visit_weekdays <@ array[1,2,3,4,5]::smallint[]
    );
  end if;
end $$;

comment on column weekrondes.visit_weekdays is
  'Dagen waarop de beheerder zelf langs kan (isodow 1=ma..5=vr). Schilders krijgen alleen deze dagen te zien en de route wordt alleen hierop gebouwd.';

-- ---------------------------------------------------------------------------
-- 2. Anchors: bezoekweek mag nu opgegeven worden; anders de oude afleiding.
-- ---------------------------------------------------------------------------
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

    if NEW.visit_week_start is null then
      -- geen keuze gemaakt => eerste hele werkweek na de deadline (oud gedrag)
      NEW.visit_week_start := deadline_date + (8 - extract(isodow from deadline_date)::int);
    else
      if extract(isodow from NEW.visit_week_start)::int <> 1 then
        raise exception 'bezoekweek moet op een maandag beginnen (kreeg %)', NEW.visit_week_start;
      end if;
      if NEW.visit_week_start <= deadline_date then
        raise exception 'bezoekweek % begint niet na de deadline %', NEW.visit_week_start, deadline_date;
      end if;
    end if;
    NEW.visit_week_end := NEW.visit_week_start + 4;
  end if;

  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Werkdagen: binnen de bezoekweek EN op een dag dat de beheerder langskomt.
-- ---------------------------------------------------------------------------
create or replace function workday_in_window()
returns trigger language plpgsql set search_path = public as $$
declare vws date; vwe date; vdays smallint[];
begin
  select w.visit_week_start, w.visit_week_end, w.visit_weekdays
    into vws, vwe, vdays
    from weekrondes w where w.id = NEW.round_id;

  if vws is not null and (NEW.work_date < vws or NEW.work_date > vwe) then
    raise exception 'work_date % valt buiten de bezoekweek % t/m %', NEW.work_date, vws, vwe;
  end if;
  if vdays is not null
     and not (extract(isodow from NEW.work_date)::smallint = any (vdays)) then
    raise exception 'work_date % valt op een dag waarop de beheerder niet langskomt', NEW.work_date;
  end if;

  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. start_weekronde: bezoekweek + eigen dagen meegeven.
--    (label vervalt: db/011 benoemt de ronde naar zijn bezoekweek)
-- ---------------------------------------------------------------------------
drop function if exists start_weekronde(text, uuid[]);

create function start_weekronde(
  p_visit_week_start date       default null,
  p_visit_days       smallint[] default null,
  p_painter_ids      uuid[]     default null
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org   uuid;
  v_round uuid;
  v_days  smallint[];
  v_count int := 0;
begin
  select a.org_id into v_org from app_admins a where a.user_id = auth.uid();
  if v_org is null then
    raise exception 'niet gemachtigd: alleen een beheerder kan een ronde starten';
  end if;
  if exists (select 1 from weekrondes w
             where w.org_id = v_org and w.status in ('sending','collecting')) then
    raise exception 'er loopt al een actieve ronde voor deze organisatie';
  end if;

  if p_visit_week_start is not null
     and extract(isodow from p_visit_week_start)::int <> 1 then
    raise exception 'kies een week die op maandag begint';
  end if;

  v_days := coalesce(p_visit_days, array[1,2,3,4,5]::smallint[]);
  if array_length(v_days, 1) is null then
    raise exception 'kies minstens één dag waarop je langs kunt';
  end if;
  if not (v_days <@ array[1,2,3,4,5]::smallint[]) then
    raise exception 'alleen maandag t/m vrijdag kunnen worden gekozen';
  end if;

  insert into weekrondes (org_id, status, sent_at, visit_week_start, visit_weekdays)
  values (v_org, 'collecting', now(), p_visit_week_start, v_days)
  returning id into v_round;

  insert into round_invites (round_id, painter_id, org_id, token_hash, status)
  select v_round, p.id, v_org, encode(gen_random_bytes(32), 'hex'), 'pending'
  from painters p
  where p.org_id = v_org
    and p.is_active
    and p.wa_opt_in_status = 'opted_in'
    and p.wa_phone_e164 is not null
    and (p_painter_ids is null or p.id = any (p_painter_ids));

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function start_weekronde(date, smallint[], uuid[]) from public, anon;
grant  execute on function start_weekronde(date, smallint[], uuid[]) to authenticated;

comment on function start_weekronde(date, smallint[], uuid[]) is
  'Opent een ronde voor een zelfgekozen bezoekweek (moet een maandag zijn, na de deadline) met de dagen waarop de beheerder zelf langs kan.';

-- ---------------------------------------------------------------------------
-- 5. Beide intake-RPC's geven visit_weekdays terug, zodat de formulieren alleen
--    de dagen tonen waarop de beheerder langskomt.
-- ---------------------------------------------------------------------------
create or replace function get_invite_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  inv    round_invites%rowtype;
  pnt    painters%rowtype;
  rnd    weekrondes%rowtype;
  addr   record;
begin
  if p_token is null or length(p_token) < 16 then
    return jsonb_build_object('ok', false, 'reason', 'malformed');
  end if;
  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  select * into inv from round_invites where token_hash = v_hash;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if inv.token_expires_at is null then
    return jsonb_build_object('ok', false, 'reason', 'no_expiry');
  end if;
  if now() >= inv.token_expires_at then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if inv.valid_from is not null and now() < inv.valid_from then
    return jsonb_build_object('ok', false, 'reason', 'not_yet_valid');
  end if;
  if inv.token_used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;

  select * into pnt from painters where id = inv.painter_id;
  if pnt.wa_opt_in_status = 'opted_out' then
    return jsonb_build_object('ok', false, 'reason', 'opted_out');
  end if;

  select * into rnd from weekrondes where id = inv.round_id;

  select pla.straat, pla.huisnummer, pla.postcode, pla.plaats
    into addr
    from painter_last_address pla
   where pla.painter_id = inv.painter_id;

  return jsonb_build_object(
    'ok', true,
    'painter_name',     pnt.full_name,
    'round_label',      rnd.label,
    'visit_week_start', rnd.visit_week_start,
    'visit_week_end',   rnd.visit_week_end,
    'visit_weekdays',   rnd.visit_weekdays,
    'deadline_at',      rnd.deadline_at,
    'prefill', case when addr.straat is not null then
        jsonb_build_object('straat', addr.straat, 'huisnummer', addr.huisnummer,
                           'postcode', addr.postcode, 'plaats', addr.plaats)
      else null end
  );
end;
$$;

create or replace function get_round_by_slug(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare rnd weekrondes%rowtype;
begin
  if p_slug is null or btrim(p_slug) = '' then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into rnd from weekrondes where public_slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if rnd.status <> 'collecting'
     or (rnd.deadline_at is not null and now() >= rnd.deadline_at) then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  return jsonb_build_object(
    'ok', true,
    'round_label',      rnd.label,
    'visit_week_start', rnd.visit_week_start,
    'visit_week_end',   rnd.visit_week_end,
    'visit_weekdays',   rnd.visit_weekdays,
    'deadline_at',      rnd.deadline_at
  );
end;
$$;

commit;
