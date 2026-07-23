-- ============================================================================
-- db/013 — Spookschilder-preventie + samenvoegen.
-- ----------------------------------------------------------------------------
-- Tot nu toe maakte submit_public_response stil een NIEUWE self-report painter
-- aan zodra het ingetypte 06-nummer niet in het roster stond. Een typefout gaf
-- dus een "spookschilder" die als reactie verschijnt terwijl de echte schilder
-- op "nog geen reactie" blijft staan. Nu:
--   1. geen match + niet bevestigd  -> reason 'phone_unknown' (niets aangemaakt),
--      zodat het formulier eerst kan vragen "klopt je nummer?".
--   2. merge_painter(bron, doel)    -> Kees kan een spookschilder samenvoegen
--      met de echte schilder (reacties verhuizen mee, spook verdwijnt).
-- ============================================================================
begin;

drop function if exists submit_public_response(text, text, text, text, text, text, text, date[], boolean);

create function submit_public_response(
  p_slug        text,
  p_name        text,
  p_phone_e164  text,
  p_straat      text    default null,
  p_huisnummer  text    default null,
  p_postcode    text    default null,
  p_plaats      text    default null,
  p_workdays    date[]  default null,
  p_no_work     boolean default false,
  p_allow_new   boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  rnd     weekrondes%rowtype;
  v_pid   uuid;
  v_inv   uuid;
  v_resp  uuid;
  v_match boolean;
  d       date;
begin
  if p_name is null or btrim(p_name) = '' then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;
  if p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then
    return jsonb_build_object('ok', false, 'reason', 'phone_invalid');
  end if;

  select * into rnd from weekrondes where public_slug = p_slug for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if rnd.status <> 'collecting'
     or (rnd.deadline_at is not null and now() >= rnd.deadline_at) then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;

  if not p_no_work then
    if p_straat is null or btrim(p_straat) = ''
       or p_huisnummer is null or btrim(p_huisnummer) = ''
       or p_plaats is null or btrim(p_plaats) = '' then
      return jsonb_build_object('ok', false, 'reason', 'address_incomplete');
    end if;
    if p_workdays is null or array_length(p_workdays, 1) is null then
      return jsonb_build_object('ok', false, 'reason', 'no_workdays');
    end if;
    foreach d in array p_workdays loop
      if rnd.visit_week_start is not null
         and (d < rnd.visit_week_start or d > rnd.visit_week_end) then
        return jsonb_build_object('ok', false, 'reason', 'workday_out_of_window');
      end if;
    end loop;
  end if;

  -- roster match by phone (org-scoped)
  select id into v_pid from painters
    where org_id = rnd.org_id and wa_phone_e164 = p_phone_e164;
  v_match := found;
  if v_match then
    if exists (select 1 from painters where id = v_pid and wa_opt_in_status = 'opted_out') then
      return jsonb_build_object('ok', false, 'reason', 'opted_out');
    end if;
  else
    -- onbekend nummer: pas aanmaken nadat de schilder heeft bevestigd
    if not p_allow_new then
      return jsonb_build_object('ok', false, 'reason', 'phone_unknown');
    end if;
    insert into painters (org_id, full_name, wa_phone_e164, wa_opt_in_status, consent_source, is_active)
    values (rnd.org_id, btrim(p_name), p_phone_e164, 'opted_in', 'self_report', true)
    returning id into v_pid;
  end if;

  insert into round_invites (round_id, painter_id, org_id, token_hash, status, responded_at)
  values (rnd.id, v_pid, rnd.org_id, encode(gen_random_bytes(16), 'hex'), 'responded', now())
  on conflict (round_id, painter_id)
    do update set status = 'responded', responded_at = now()
  returning id into v_inv;

  if p_no_work then
    delete from invite_responses where invite_id = v_inv;
    return jsonb_build_object('ok', true, 'matched', v_match, 'no_work', true);
  end if;

  insert into invite_responses
    (invite_id, round_id, org_id, straat, huisnummer, postcode, plaats, geocode_status)
  values
    (v_inv, rnd.id, rnd.org_id, btrim(p_straat), btrim(p_huisnummer),
     nullif(btrim(p_postcode), ''), btrim(p_plaats), 'pending')
  on conflict (invite_id) do update set
    straat = excluded.straat, huisnummer = excluded.huisnummer,
    postcode = excluded.postcode, plaats = excluded.plaats,
    geocode_status = 'pending', geocode_attempts = 0, geocode_leased_until = null,
    lat = null, lng = null, manual_override = false, admin_corrected_at = null,
    submitted_at = now(), updated_at = now()
  returning id into v_resp;

  delete from response_workdays where response_id = v_resp;
  foreach d in array p_workdays loop
    insert into response_workdays (response_id, round_id, work_date, weekday)
    values (v_resp, rnd.id, d, extract(isodow from d)::smallint)
    on conflict (response_id, work_date) do nothing;
  end loop;

  return jsonb_build_object('ok', true, 'matched', v_match, 'no_work', false);
end;
$$;

revoke execute on function submit_public_response(text, text, text, text, text, text, text, date[], boolean, boolean)
  from public, anon, authenticated;
grant execute on function submit_public_response(text, text, text, text, text, text, text, date[], boolean, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- merge_painter: voeg de BRON-schilder samen met de DOEL-schilder. Elke ronde-
-- uitnodiging van de bron verhuist naar het doel; heeft het doel die ronde al
-- een uitnodiging, dan wint de reactie van de bron (daar heeft de schilder het
-- ingevuld). Route-deelnames wijzen daarna naar het doel; de bron wordt gewist.
-- ---------------------------------------------------------------------------
create or replace function merge_painter(p_source uuid, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org uuid; v_torg uuid; inv record; t_inv uuid; s_has_resp boolean;
begin
  if p_source = p_target then raise exception 'bron en doel zijn dezelfde schilder'; end if;
  select org_id into v_org  from painters where id = p_source;
  select org_id into v_torg from painters where id = p_target;
  if v_org is null or v_torg is null then raise exception 'schilder niet gevonden'; end if;
  if v_org <> v_torg then raise exception 'schilders horen bij verschillende organisaties'; end if;
  if not is_admin_of(v_org) then raise exception 'niet gemachtigd'; end if;

  for inv in select * from round_invites where painter_id = p_source loop
    select id into t_inv from round_invites
      where round_id = inv.round_id and painter_id = p_target;
    if t_inv is null then
      update round_invites set painter_id = p_target where id = inv.id;
    else
      s_has_resp := exists (select 1 from invite_responses where invite_id = inv.id);
      if s_has_resp then
        delete from route_stop_painters
          where response_id in (select id from invite_responses where invite_id = t_inv);
        delete from round_invites where id = t_inv; -- cascades target response + workdays
        update round_invites set painter_id = p_target where id = inv.id;
      else
        delete from round_invites where id = inv.id;
      end if;
    end if;
  end loop;

  -- route-deelnames naar het doel (eerst dubbelen binnen een plan opruimen)
  delete from route_stop_painters rsp
   where rsp.painter_id = p_source
     and exists (select 1 from route_stop_painters o
                 where o.route_plan_id = rsp.route_plan_id and o.painter_id = p_target);
  update route_stop_painters set painter_id = p_target where painter_id = p_source;

  delete from painters where id = p_source;
end;
$$;

revoke execute on function merge_painter(uuid, uuid) from public, anon;
grant  execute on function merge_painter(uuid, uuid) to authenticated;

comment on function merge_painter(uuid, uuid) is
  'Voegt bron-schilder samen met doel-schilder (reacties/route verhuizen mee, bron verwijderd). Alleen een beheerder van dezelfde org.';

commit;
