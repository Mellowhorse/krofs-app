-- ============================================================================
-- Krofs schilderbezoek-planner — db/007 AUTOMATED OUTBOX (Phase 2b)
-- ----------------------------------------------------------------------------
-- Moves dispatch from manual (wa.me links) to an automated transactional
-- outbox driven by the /tick sweep (external cron). Assumes Meta Cloud API.
--
--  * start_weekronde now opens a round with invites in status='pending'
--    (awaiting dispatch) and returns the COUNT. Tokens are minted at SEND time
--    (claim_invite_for_send), never at round start — so the raw token exists
--    only transiently in the sweep's memory and is never stored.
--  * claim_invite_for_send: the OUTBOX phase-1 claim. In one tx: mint a fresh
--    token (rotate hash), stamp invite_sent_at (=> expiry via guard), insert a
--    message_log 'queued' row keyed by idempotency_key, and RETURN the raw
--    token + phone so the caller (service_role /tick) can send via Meta and
--    then flip the message_log to sent/failed. Idempotent + concurrency-safe.
--  * close_due_rounds: time-based hard close at deadline (day-5), + expire the
--    non-responded invites of closed rounds.
--
-- regenerate_invite_tokens (db/006) stays: the MANUAL wa.me fallback still
-- works (mints tokens + status='sent'); the auto sweep only touches 'pending'.
-- Requires db/001..006.
-- ============================================================================

begin;

-- start_weekronde: return type changes (table -> int), so drop + recreate.
drop function if exists start_weekronde(text, uuid[]);

create function start_weekronde(
  p_label       text   default null,
  p_painter_ids uuid[] default null
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org   uuid;
  v_round uuid;
  v_count int := 0;
begin
  select a.org_id into v_org from app_admins a where a.user_id = auth.uid();
  if v_org is null then
    raise exception 'niet gemachtigd: alleen een beheerder kan een ronde starten';
  end if;
  if exists (select 1 from weekrondes w where w.org_id = v_org and w.status in ('sending','collecting')) then
    raise exception 'er loopt al een actieve ronde voor deze organisatie';
  end if;

  insert into weekrondes (org_id, label, status, sent_at)
  values (v_org, coalesce(nullif(btrim(p_label), ''), to_char(now(), '"Week" IW YYYY')),
          'collecting', now())
  returning id into v_round;

  -- One PENDING invite per eligible painter. token_hash is a random placeholder
  -- (no known preimage => no working link) until the sweep mints the real token.
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

revoke execute on function start_weekronde(text, uuid[]) from public, anon;
grant  execute on function start_weekronde(text, uuid[]) to authenticated;

-- ---------- outbox claim (service_role / the /tick sweep) --------------------
create or replace function claim_invite_for_send(
  p_invite_id uuid,
  p_kind      text default 'invite'
)
returns table (
  raw_token  text,
  to_phone   text,
  full_name  text,
  org_id     uuid,
  message_id uuid
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  inv   round_invites%rowtype;
  pnt   painters%rowtype;
  v_raw text;
  v_key text;
  v_msg uuid;
begin
  select * into inv from round_invites where id = p_invite_id for update;
  if not found then return; end if;

  select * into pnt from painters where id = inv.painter_id;
  if pnt.wa_opt_in_status <> 'opted_in' or pnt.wa_phone_e164 is null then return; end if;

  v_key := p_kind || ':' || p_invite_id::text;

  -- Claim the outbox slot FIRST (before minting a token) so an already-sent
  -- invite is never re-rotated. A prior 'failed' row is re-queued (retry);
  -- a 'sent'/'queued' row updates nothing -> no id -> skip.
  insert into message_log (org_id, painter_id, invite_id, direction, kind,
                           idempotency_key, status, to_phone_e164)
  values (inv.org_id, inv.painter_id, p_invite_id, 'outbound', p_kind::message_kind,
          v_key, 'queued', pnt.wa_phone_e164)
  on conflict (idempotency_key) do update
     set status = 'queued', to_phone_e164 = excluded.to_phone_e164
   where message_log.status = 'failed'
  returning id into v_msg;

  if v_msg is null then return; end if;  -- already sent / in flight

  -- Won the claim: now mint the token and stamp the invite.
  v_raw := encode(gen_random_bytes(24), 'hex');
  update round_invites
     set token_hash       = encode(digest(v_raw, 'sha256'), 'hex'),
         invite_sent_at   = coalesce(invite_sent_at, now()),
         token_expires_at = null,  -- re-stamped to round deadline by invite_expiry_guard
         status           = (case when p_kind = 'reminder' then 'reminded' else 'sent' end)::invite_status,
         reminder_sent_at = case when p_kind = 'reminder' then now() else reminder_sent_at end
   where id = p_invite_id;

  raw_token  := v_raw;
  to_phone   := pnt.wa_phone_e164;
  full_name  := pnt.full_name;
  org_id     := inv.org_id;
  message_id := v_msg;
  return next;
end;
$$;

revoke execute on function claim_invite_for_send(uuid, text) from public, anon, authenticated;
grant  execute on function claim_invite_for_send(uuid, text) to service_role;

-- ---------- time-based close (service_role / the /tick sweep) ----------------
create or replace function close_due_rounds()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update weekrondes
     set status = 'closed', closed_at = now()
   where status = 'collecting' and deadline_at is not null and deadline_at <= now();
  get diagnostics n = row_count;

  update round_invites ri
     set status = 'expired'
    from weekrondes w
   where ri.round_id = w.id
     and w.status = 'closed'
     and ri.token_used_at is null
     and ri.status in ('pending', 'sent', 'reminded');

  return n;
end;
$$;

revoke execute on function close_due_rounds() from public, anon, authenticated;
grant  execute on function close_due_rounds() to service_role;

comment on function claim_invite_for_send(uuid, text) is
  'Outbox phase-1 claim (service_role): mints a fresh token, queues a message_log row (idempotent on kind:invite_id), returns the raw token so the sweep can send via Meta then flip status. Raw token never persisted.';
comment on function close_due_rounds() is
  'Time-based hard close (service_role): closes collecting rounds past deadline_at and expires their non-responded invites.';

commit;

-- ---------- sweep helper queries (service_role) -----------------------------
create or replace function pending_invite_ids(p_limit int default 200)
returns setof uuid language sql security definer set search_path = public stable as $$
  select ri.id
  from round_invites ri
  join weekrondes w on w.id = ri.round_id
  join painters   p on p.id = ri.painter_id
  where w.status = 'collecting' and ri.status = 'pending'
    and p.wa_opt_in_status = 'opted_in' and p.wa_phone_e164 is not null
  order by ri.created_at
  limit p_limit;
$$;

create or replace function due_reminder_ids(p_limit int default 200)
returns setof uuid language sql security definer set search_path = public stable as $$
  select ri.id
  from round_invites ri
  join weekrondes w on w.id = ri.round_id
  join painters   p on p.id = ri.painter_id
  where w.status = 'collecting' and ri.status = 'sent'
    and ri.reminder_sent_at is null
    and w.reminder_at is not null and w.reminder_at <= now()
    and p.wa_opt_in_status = 'opted_in' and p.wa_phone_e164 is not null
  order by ri.created_at
  limit p_limit;
$$;

revoke execute on function pending_invite_ids(int) from public, anon, authenticated;
revoke execute on function due_reminder_ids(int)  from public, anon, authenticated;
grant  execute on function pending_invite_ids(int) to service_role;
grant  execute on function due_reminder_ids(int)  to service_role;
