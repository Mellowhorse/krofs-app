-- ============================================================================
-- Krofs schilderbezoek-planner — db/005 PAINTER RPCs (Phase 1)
-- ----------------------------------------------------------------------------
-- The no-login painter path. Two SECURITY DEFINER functions, callable ONLY by
-- service_role (the Next.js /r/{token} SERVER route calls them; the browser
-- never gets service_role, and anon/authenticated EXECUTE is revoked). Each
-- keys strictly on sha256(token) and returns/writes ONLY that one invite —
-- cross-token / cross-tenant safe by construction.
--
--   get_invite_by_token(p_token)   -> jsonb {ok, painter_name, round_label,
--                                     visit_week_start/end, deadline_at, prefill}
--                                     or {ok:false, reason} (server logs reason;
--                                     the Next route collapses ALL failures to one
--                                     opaque page — no used/expired/unknown oracle).
--   submit_response(p_token, addr, workdays[], no_work)
--                                  -> jsonb {ok} or {ok:false, reason}.
--                                     Single-use (atomic token_used_at claim),
--                                     fail-closed, workdays validated in-window.
--
-- search_path = public, extensions  so digest() resolves both on Supabase
-- (pgcrypto in `extensions`) and in CI (pgcrypto in `public`). Missing schemas
-- in a search_path are ignored, so this is safe in both.
-- REVIEW BEFORE APPLY. Requires db/001..004.
-- ============================================================================

begin;

-- ---------- get_invite_by_token ---------------------------------------------
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
    'deadline_at',      rnd.deadline_at,
    'prefill', case when addr.straat is not null then
        jsonb_build_object('straat', addr.straat, 'huisnummer', addr.huisnummer,
                           'postcode', addr.postcode, 'plaats', addr.plaats)
      else null end
  );
end;
$$;

-- ---------- submit_response --------------------------------------------------
create or replace function submit_response(
  p_token      text,
  p_straat     text     default null,
  p_huisnummer text     default null,
  p_postcode   text     default null,
  p_plaats     text     default null,
  p_workdays   date[]   default null,
  p_no_work    boolean  default false
)
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
  v_resp uuid;
  d      date;
begin
  if p_token is null or length(p_token) < 16 then
    return jsonb_build_object('ok', false, 'reason', 'malformed');
  end if;
  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  -- lock the invite row for the single-use claim
  select * into inv from round_invites where token_hash = v_hash for update;
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

  -- single-use claim (atomic; races lose here)
  update round_invites
     set token_used_at = now(), responded_at = now(), status = 'responded'
   where id = inv.id and token_used_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;

  if not p_no_work then
    insert into invite_responses
      (invite_id, round_id, org_id, straat, huisnummer, postcode, plaats, geocode_status)
    values
      (inv.id, inv.round_id, inv.org_id,
       btrim(p_straat), btrim(p_huisnummer), nullif(btrim(p_postcode), ''), btrim(p_plaats),
       'pending')
    returning id into v_resp;

    foreach d in array p_workdays loop
      insert into response_workdays (response_id, round_id, work_date, weekday)
      values (v_resp, inv.round_id, d, extract(isodow from d)::smallint)
      on conflict (response_id, work_date) do nothing;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'no_work', p_no_work);
end;
$$;

-- ---------- least privilege: service_role only (Next server route) ----------
revoke execute on function get_invite_by_token(text)
  from public, anon, authenticated;
grant  execute on function get_invite_by_token(text) to service_role;

revoke execute on function submit_response(text, text, text, text, text, date[], boolean)
  from public, anon, authenticated;
grant  execute on function submit_response(text, text, text, text, text, date[], boolean)
  to service_role;

comment on function get_invite_by_token(text) is
  'Painter no-login GET: validates sha256(token) fail-closed, returns only that invite''s own display fields + prefill. service_role only.';
comment on function submit_response(text, text, text, text, text, date[], boolean) is
  'Painter no-login submit: single-use atomic claim, fail-closed, workdays validated in-window; writes invite_responses + response_workdays. service_role only.';

commit;
