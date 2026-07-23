-- ============================================================================
-- db/015 — Per dag een dagdeel: hele dag, ochtend of middag.
-- ----------------------------------------------------------------------------
-- visit_weekdays zei alleen WELKE dagen de beheerder langs kan; elke dag gold
-- als een hele dag. Nu kan hij per dag kiezen: heel / ochtend / middag. Dat
-- geeft per dag een eigen tijdvenster én een eigen capaciteit, zodat een
-- ochtend-dag niet volloopt alsof het een hele dag is.
--
-- visit_weekdays blijft bestaan (welke dagen) — het is de sleutelverzameling
-- van visit_day_parts en wordt door start_weekronde consistent gezet. Oude
-- rondes houden '{}' = alle gekozen dagen zijn hele dagen.
-- ============================================================================
begin;

alter table weekrondes
  add column if not exists visit_day_parts jsonb not null default '{}'::jsonb;

comment on column weekrondes.visit_day_parts is
  'Dagdeel per werkdag, bv. {"1":"heel","3":"ochtend"} (sleutel = isodow 1-5). Leeg = alle dagen in visit_weekdays gelden als hele dag.';

-- ---------------------------------------------------------------------------
-- start_weekronde: dagdelen i.p.v. een kale dagenlijst.
-- ---------------------------------------------------------------------------
drop function if exists start_weekronde(date, smallint[], uuid[]);

create function start_weekronde(
  p_visit_week_start date    default null,
  p_day_parts        jsonb   default null,
  p_painter_ids      uuid[]  default null
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org   uuid;
  v_round uuid;
  v_parts jsonb;
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

  v_parts := coalesce(p_day_parts, '{"1":"heel","2":"heel","3":"heel","4":"heel","5":"heel"}'::jsonb);
  if v_parts = '{}'::jsonb then
    raise exception 'kies minstens één dag waarop je langs kunt';
  end if;
  if exists (
    select 1 from jsonb_each_text(v_parts) e
    where e.key not in ('1','2','3','4','5')
       or e.value not in ('heel','ochtend','middag')
  ) then
    raise exception 'ongeldige dagkeuze (alleen ma-vr met heel/ochtend/middag)';
  end if;

  select array_agg(k::smallint order by k::smallint) into v_days
    from jsonb_object_keys(v_parts) as k;

  insert into weekrondes (org_id, status, sent_at, visit_week_start, visit_weekdays, visit_day_parts)
  values (v_org, 'collecting', now(), p_visit_week_start, v_days, v_parts)
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

revoke execute on function start_weekronde(date, jsonb, uuid[]) from public, anon;
grant  execute on function start_weekronde(date, jsonb, uuid[]) to authenticated;

comment on function start_weekronde(date, jsonb, uuid[]) is
  'Opent een ronde voor een zelfgekozen bezoekweek met per dag een dagdeel ({"1":"heel","3":"ochtend"}); vult visit_weekdays consistent uit de sleutels.';

commit;
