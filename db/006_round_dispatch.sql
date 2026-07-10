-- ============================================================================
-- Krofs schilderbezoek-planner — db/006 ROUND DISPATCH (Phase 2)
-- ----------------------------------------------------------------------------
-- start_weekronde: the admin (Ruben) opens a weekronde and mints one invite
-- per eligible painter. SECURITY DEFINER, callable by an authenticated admin
-- (derives org from app_admins via auth.uid(); rejects non-admins). Returns
-- the RAW tokens ONCE so the caller can build per-painter links; only the
-- sha256 hash is persisted (raw token never stored), matching db/005.
--
-- Eligibility: is_active AND wa_opt_in_status='opted_in' (opt-in gate). Guarded
-- to one active round per org (also enforced by idx_weekrondes_one_active).
--
-- MVP dispatch is MANUAL (the admin sends the returned wa.me links). The
-- automated WhatsApp outbox (message_log queued -> BSP send) lands in a later
-- Phase-2b migration once Meta is verified; nothing here writes message_log,
-- so there are no dangling 'queued' rows in the manual model.
-- Requires db/001..005.
-- ============================================================================

begin;

create or replace function start_weekronde(
  p_label       text     default null,
  p_painter_ids uuid[]   default null
)
returns table (
  invite_id     uuid,
  painter_id    uuid,
  full_name     text,
  wa_phone_e164 text,
  raw_token     text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org   uuid;
  v_round uuid;
  rec     record;
  v_raw   text;
begin
  select a.org_id into v_org from app_admins a where a.user_id = auth.uid();
  if v_org is null then
    raise exception 'niet gemachtigd: alleen een beheerder kan een ronde starten';
  end if;

  if exists (
    select 1 from weekrondes w
    where w.org_id = v_org and w.status in ('sending', 'collecting')
  ) then
    raise exception 'er loopt al een actieve ronde voor deze organisatie';
  end if;

  insert into weekrondes (org_id, label, status, sent_at)
  values (v_org, coalesce(nullif(btrim(p_label), ''), to_char(now(), '"Week" IW YYYY')),
          'collecting', now())
  returning id into v_round;

  for rec in
    select p.id, p.full_name, p.wa_phone_e164
    from painters p
    where p.org_id = v_org
      and p.is_active
      and p.wa_opt_in_status = 'opted_in'
      and p.wa_phone_e164 is not null
      and (p_painter_ids is null or p.id = any (p_painter_ids))
    order by p.full_name
  loop
    v_raw := encode(gen_random_bytes(24), 'hex');
    insert into round_invites (round_id, painter_id, org_id, token_hash, status, invite_sent_at)
    values (v_round, rec.id, v_org, encode(digest(v_raw, 'sha256'), 'hex'), 'sent', now())
    returning id into invite_id;

    painter_id    := rec.id;
    full_name     := rec.full_name;
    wa_phone_e164 := rec.wa_phone_e164;
    raw_token     := v_raw;
    return next;
  end loop;
end;
$$;

revoke execute on function start_weekronde(text, uuid[]) from public, anon;
grant  execute on function start_weekronde(text, uuid[]) to authenticated;

comment on function start_weekronde(text, uuid[]) is
  'Admin-only (auth.uid() must be in app_admins): opens a weekronde and mints one invite per eligible (active, opted_in) painter. Returns raw tokens ONCE; only sha256 hashes are stored. One active round per org.';

commit;

-- ============================================================================
-- regenerate_invite_tokens: re-mint tokens for the not-yet-responded invites of
-- a round and return the raw tokens, so the admin can re-open the send links
-- without them ever being stored. Rotating invalidates any old link (secure).
-- Responded invites are left untouched.
-- ============================================================================
create or replace function regenerate_invite_tokens(p_round_id uuid)
returns table (
  invite_id     uuid,
  painter_id    uuid,
  full_name     text,
  wa_phone_e164 text,
  raw_token     text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org uuid;
  rec   record;
  v_raw text;
begin
  select a.org_id into v_org from app_admins a where a.user_id = auth.uid();
  if v_org is null then
    raise exception 'niet gemachtigd';
  end if;
  if not exists (select 1 from weekrondes w where w.id = p_round_id and w.org_id = v_org) then
    raise exception 'ronde niet gevonden';
  end if;

  for rec in
    select ri.id, ri.painter_id, p.full_name, p.wa_phone_e164
    from round_invites ri
    join painters p on p.id = ri.painter_id
    where ri.round_id = p_round_id
      and ri.token_used_at is null
      and p.wa_opt_in_status = 'opted_in'
      and p.wa_phone_e164 is not null
    order by p.full_name
  loop
    v_raw := encode(gen_random_bytes(24), 'hex');
    update round_invites
       set token_hash = encode(digest(v_raw, 'sha256'), 'hex'),
           invite_sent_at = now(),
           token_expires_at = null,   -- re-stamped to round deadline by invite_expiry_guard
           status = 'sent'
     where id = rec.id;

    invite_id     := rec.id;
    painter_id    := rec.painter_id;
    full_name     := rec.full_name;
    wa_phone_e164 := rec.wa_phone_e164;
    raw_token     := v_raw;
    return next;
  end loop;
end;
$$;

revoke execute on function regenerate_invite_tokens(uuid) from public, anon;
grant  execute on function regenerate_invite_tokens(uuid) to authenticated;
