-- ============================================================================
-- db/010 — Option 2: shared, broadcast-friendly intake link per round.
-- ----------------------------------------------------------------------------
-- One URL for the whole round (/u/{slug}) instead of a per-painter token, so
-- the invite can go out via a WhatsApp broadcast list. The painter self-
-- identifies by PHONE on the form: the backend matches the number against the
-- roster (dedupe + link back to the known painter), and creates a new painter
-- from the typed name + phone when there's no match. Low-security by design —
-- the slug is meant to be broadcast, so it is stored in plaintext.
--
-- The per-painter token flow (db/005) stays; this is an additional intake path.
-- Every submission still hangs off a round_invite -> painter, so the route
-- builder, geocode sweep and dashboards keep working unchanged.
-- ============================================================================
begin;

alter table weekrondes
  add column if not exists public_slug text;

update weekrondes set public_slug = replace(gen_random_uuid()::text, '-', '')
  where public_slug is null;

alter table weekrondes
  alter column public_slug set default replace(gen_random_uuid()::text, '-', ''),
  alter column public_slug set not null;

create unique index if not exists idx_weekrondes_public_slug on weekrondes(public_slug);

comment on column weekrondes.public_slug is
  'Shared broadcast intake slug: /u/{slug} opens the round''s open self-identify form (Option 2). Not a per-painter secret.';

-- ---------------------------------------------------------------------------
-- Public read: resolve a slug to the round's form context. Opaque failure so
-- the slug is not an open/closed oracle beyond the single "closed" reason.
-- ---------------------------------------------------------------------------
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
    'round_label', rnd.label,
    'visit_week_start', rnd.visit_week_start,
    'visit_week_end', rnd.visit_week_end,
    'deadline_at', rnd.deadline_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Public write: self-identify submission. Phone must already be normalized to
-- E.164 by the caller (the server action reuses lib/phone). Matches/creates the
-- painter, find-or-creates the round invite (status responded, filler token —
-- never used as a link), upserts the response + workdays (re-submit overwrites,
-- so a painter can correct their answer while the round is open).
-- ---------------------------------------------------------------------------
create or replace function submit_public_response(
  p_slug        text,
  p_name        text,
  p_phone_e164  text,
  p_straat      text    default null,
  p_huisnummer  text    default null,
  p_postcode    text    default null,
  p_plaats      text    default null,
  p_workdays    date[]  default null,
  p_no_work     boolean default false
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

  -- roster match by phone (org-scoped); create a self-report painter if unknown
  select id into v_pid from painters
    where org_id = rnd.org_id and wa_phone_e164 = p_phone_e164;
  v_match := found;
  if v_match then
    if exists (select 1 from painters where id = v_pid and wa_opt_in_status = 'opted_out') then
      return jsonb_build_object('ok', false, 'reason', 'opted_out');
    end if;
  else
    insert into painters (org_id, full_name, wa_phone_e164, wa_opt_in_status, consent_source, is_active)
    values (rnd.org_id, btrim(p_name), p_phone_e164, 'opted_in', 'self_report', true)
    returning id into v_pid;
  end if;

  -- find-or-create the invite; token_hash is a filler (no link is ever minted)
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

revoke execute on function get_round_by_slug(text) from public, anon, authenticated;
revoke execute on function submit_public_response(text, text, text, text, text, text, text, date[], boolean)
  from public, anon, authenticated;
grant execute on function get_round_by_slug(text) to service_role;
grant execute on function submit_public_response(text, text, text, text, text, text, text, date[], boolean)
  to service_role;

comment on function get_round_by_slug(text) is
  'Public (service_role) slug -> round form context; opaque closed/not_found otherwise.';
comment on function submit_public_response(text, text, text, text, text, text, text, date[], boolean) is
  'Public (service_role) self-identify intake: match/create painter by phone, find-or-create invite, upsert response + workdays. Re-submit overwrites while the round is open.';

commit;
