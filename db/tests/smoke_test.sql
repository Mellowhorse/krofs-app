-- ============================================================================
-- Smoke tests — executable subset of the 45-scenario test matrix
-- (docs/backend_design.md). Runs in CI after db/001..003 on a fresh DB.
-- Every block raises on failure; last line prints ALL SMOKE TESTS PASSED.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Fixtures (fixed UUIDs so blocks can reference each other)
-- ---------------------------------------------------------------------------
insert into organizations (id, name)
values ('00000000-0000-0000-0000-0000000000a1', 'Krofs CI')
on conflict (id) do nothing;

insert into organizations (id, name, deadline_days)
values ('00000000-0000-0000-0000-0000000000a2', 'Krofs CI kort', 3)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- T1 — Monday send: anchors (wall-time reminder, midnight deadline, Mon–Fri window)
-- ---------------------------------------------------------------------------
do $$
declare r weekrondes%rowtype;
begin
  insert into weekrondes (id, org_id, label, sent_at)
  values ('00000000-0000-0000-0000-0000000000b1',
          '00000000-0000-0000-0000-0000000000a1',
          'T1 ma-send',
          ('2026-07-06 09:00'::timestamp at time zone 'Europe/Amsterdam'))
  returning * into r;

  if r.reminder_at is distinct from ('2026-07-07 09:00'::timestamp at time zone 'Europe/Amsterdam') then
    raise exception 'T1 reminder_at wrong: %', r.reminder_at;
  end if;
  if r.deadline_at is distinct from ('2026-07-12 00:00'::timestamp at time zone 'Europe/Amsterdam') then
    raise exception 'T1 deadline_at wrong (expected start of day 6 = Sun 12 Jul 00:00 local): %', r.deadline_at;
  end if;
  if r.visit_week_start is distinct from date '2026-07-13' or r.visit_week_end is distinct from date '2026-07-17' then
    raise exception 'T1 visit window wrong: % .. %', r.visit_week_start, r.visit_week_end;
  end if;
  raise notice 'T1 ok — Monday-send anchors';
end $$;

-- ---------------------------------------------------------------------------
-- T2 — DST spring-forward: reminder keeps local wall-time (23h elapsed)
--      Send Sat 2026-03-28 09:00 CET; clocks jump Sun 2026-03-29 02:00->03:00.
-- ---------------------------------------------------------------------------
do $$
declare r weekrondes%rowtype;
begin
  insert into weekrondes (id, org_id, label, sent_at)
  values ('00000000-0000-0000-0000-0000000000b2',
          '00000000-0000-0000-0000-0000000000a1',
          'T2 dst',
          ('2026-03-28 09:00'::timestamp at time zone 'Europe/Amsterdam'))
  returning * into r;

  if (r.reminder_at at time zone 'Europe/Amsterdam')::time is distinct from time '09:00' then
    raise exception 'T2 reminder local wall-time wrong: %', r.reminder_at at time zone 'Europe/Amsterdam';
  end if;
  if r.reminder_at - r.sent_at is distinct from interval '23 hours' then
    raise exception 'T2 expected 23h elapsed across spring-forward, got %', r.reminder_at - r.sent_at;
  end if;
  raise notice 'T2 ok — DST-safe reminder';
end $$;

-- ---------------------------------------------------------------------------
-- T3 — deadline_days org setting: 3 days -> closes start of day 4
-- ---------------------------------------------------------------------------
do $$
declare r weekrondes%rowtype;
begin
  insert into weekrondes (id, org_id, label, sent_at)
  values ('00000000-0000-0000-0000-0000000000b3',
          '00000000-0000-0000-0000-0000000000a2',
          'T3 kort',
          ('2026-07-06 09:00'::timestamp at time zone 'Europe/Amsterdam'))
  returning * into r;

  if r.deadline_at is distinct from ('2026-07-10 00:00'::timestamp at time zone 'Europe/Amsterdam') then
    raise exception 'T3 deadline_at wrong for deadline_days=3: %', r.deadline_at;
  end if;
  if r.visit_week_start is distinct from date '2026-07-13' then
    raise exception 'T3 visit_week_start wrong: %', r.visit_week_start;
  end if;
  raise notice 'T3 ok — configurable deadline_days';
end $$;

-- ---------------------------------------------------------------------------
-- T4 — token_expires_at auto-stamped = round deadline_at on send
-- ---------------------------------------------------------------------------
do $$
declare inv round_invites%rowtype; dl timestamptz;
begin
  insert into painters (id, org_id, full_name, wa_phone_e164, wa_opt_in_status)
  values ('00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000a1',
          'CI Schilder', '+31610000001', 'opted_in');

  insert into round_invites (id, round_id, painter_id, org_id, token_hash, status, invite_sent_at)
  values ('00000000-0000-0000-0000-0000000000d1',
          '00000000-0000-0000-0000-0000000000b1',
          '00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000a1',
          encode(digest('ci-token-1', 'sha256'), 'hex'),
          'sent', now())
  returning * into inv;

  select deadline_at into dl from weekrondes where id = inv.round_id;
  if inv.token_expires_at is distinct from dl then
    raise exception 'T4 token_expires_at (%) <> round deadline_at (%)', inv.token_expires_at, dl;
  end if;
  raise notice 'T4 ok — token expiry = deadline';
end $$;

-- ---------------------------------------------------------------------------
-- T5 — workday window: inside accepted; below/above the window rejected
-- ---------------------------------------------------------------------------
do $$
declare vws date; vwe date; rejected boolean;
begin
  insert into invite_responses (id, invite_id, round_id, org_id, straat, huisnummer, plaats)
  values ('00000000-0000-0000-0000-0000000000e1',
          '00000000-0000-0000-0000-0000000000d1',
          '00000000-0000-0000-0000-0000000000b1',
          '00000000-0000-0000-0000-0000000000a1',
          'Stationsplein', '12', 'Amersfoort');

  select visit_week_start, visit_week_end into vws, vwe
    from weekrondes where id = '00000000-0000-0000-0000-0000000000b1';

  -- inside: must succeed
  insert into response_workdays (response_id, round_id, work_date, weekday)
  values ('00000000-0000-0000-0000-0000000000e1',
          '00000000-0000-0000-0000-0000000000b1',
          vws, extract(isodow from vws)::smallint);

  -- below lower bound: must be rejected
  rejected := false;
  begin
    insert into response_workdays (response_id, round_id, work_date, weekday)
    values ('00000000-0000-0000-0000-0000000000e1',
            '00000000-0000-0000-0000-0000000000b1',
            vws - 1, extract(isodow from vws - 1)::smallint);
  exception when others then rejected := true;
  end;
  if not rejected then
    raise exception 'T5 work_date below visit_week_start was accepted';
  end if;

  -- above upper bound: must be rejected (the db/002 both-bounds fix)
  rejected := false;
  begin
    insert into response_workdays (response_id, round_id, work_date, weekday)
    values ('00000000-0000-0000-0000-0000000000e1',
            '00000000-0000-0000-0000-0000000000b1',
            vwe + 1, extract(isodow from vwe + 1)::smallint);
  exception when others then rejected := true;
  end;
  if not rejected then
    raise exception 'T5 work_date above visit_week_end was accepted';
  end if;

  raise notice 'T5 ok — workday window bounds';
end $$;

-- ---------------------------------------------------------------------------
-- T6 — db/003 surface: enum values, columns, views
-- ---------------------------------------------------------------------------
do $$
begin
  perform 'location_confirm'::message_kind;
  perform 'route_ready'::message_kind;
  perform visited_at from route_stops limit 0;
  perform location_confirm_sent_at, location_confirmed_at from invite_responses limit 0;
  perform handled_at from message_log limit 0;
  perform * from painter_last_visited limit 0;
  perform * from painter_last_address limit 0;
  raise notice 'T6 ok — db/003 surface present';
end $$;

-- ---------------------------------------------------------------------------
-- T7 — painter RPCs (db/005): get, cross-token isolation, submit, single-use
-- ---------------------------------------------------------------------------
do $$
declare
  v_org uuid := '00000000-0000-0000-0000-0000000000e1';
  v_p1  uuid := '00000000-0000-0000-0000-0000000000e2';
  v_p2  uuid := '00000000-0000-0000-0000-0000000000e3';
  v_rnd uuid := '00000000-0000-0000-0000-0000000000e4';
  tokA text := 'SMOKETOKENA-aaaa11112222';
  tokB text := 'SMOKETOKENB-bbbb33334444';
  vws date; r jsonb; n int;
begin
  insert into organizations (id,name) values (v_org,'rpc-smoke');
  insert into painters (id,org_id,full_name,wa_phone_e164,wa_opt_in_status) values
    (v_p1,v_org,'Een','+31610009001','opted_in'),
    (v_p2,v_org,'Twee','+31610009002','opted_in');
  insert into weekrondes (id,org_id,label,status,sent_at)
    values (v_rnd,v_org,'smoke','collecting', now());
  select visit_week_start into vws from weekrondes where id=v_rnd;
  insert into round_invites (round_id,painter_id,org_id,token_hash,status,invite_sent_at) values
    (v_rnd,v_p1,v_org, encode(digest(tokA,'sha256'),'hex'),'sent',now()),
    (v_rnd,v_p2,v_org, encode(digest(tokB,'sha256'),'hex'),'sent',now());

  r := get_invite_by_token(tokA);
  if (r->>'ok')<>'true' or (r->>'painter_name')<>'Een' then raise exception 'RPC get valid: %', r; end if;
  r := get_invite_by_token(tokB);
  if (r->>'painter_name')<>'Twee' then raise exception 'RPC cross-token isolation: %', r; end if;
  r := submit_response(tokA,'Straat','1','1234 AB','Amersfoort', array[vws]::date[], false);
  if (r->>'ok')<>'true' then raise exception 'RPC valid submit: %', r; end if;
  r := submit_response(tokA,'Straat','1','1234 AB','Amersfoort', array[vws]::date[], false);
  if (r->>'reason')<>'used' then raise exception 'RPC single-use: %', r; end if;
  select count(*) into n from response_workdays; if n < 1 then raise exception 'RPC workday not written'; end if;
  raise notice 'T7 ok — painter RPCs';
end $$;

-- T8 — Option 2 public intake (db/010): slug resolve, self-report create,
-- dedup on re-submit, roster match by phone, opaque unknown slug.
do $$
declare
  v_org uuid; v_rnd uuid; slug text; vws date; r jsonb; n int;
begin
  insert into organizations (name) values ('smoke-intake') returning id into v_org;
  insert into weekrondes (org_id, label, status, sent_at)
    values (v_org, 'intake', 'collecting', now()) returning id into v_rnd;
  select visit_week_start, public_slug into vws, slug from weekrondes where id = v_rnd;

  r := get_round_by_slug(slug);
  if (r->>'ok') <> 'true' then raise exception 'T8 slug resolve: %', r; end if;

  -- unknown phone WITH confirmation => a self-report painter is created
  r := submit_public_response(slug, 'Nieuwe Schilder', '+31611110001',
        'Straat', '1', '1234 AB', 'Amersfoort', array[vws]::date[], false, true);
  if (r->>'ok') <> 'true' or (r->>'matched') <> 'false' then raise exception 'T8 create: %', r; end if;
  select count(*) into n from painters where org_id = v_org and wa_phone_e164 = '+31611110001';
  if n <> 1 then raise exception 'T8 painter not created (n=%)', n; end if;

  -- re-submit same phone => dedup (one painter, one invite), address updated
  r := submit_public_response(slug, 'Nieuwe Schilder', '+31611110001',
        'Andereweg', '9', null, 'Baarn', array[vws]::date[], false, true);
  if (r->>'ok') <> 'true' then raise exception 'T8 resubmit: %', r; end if;
  select count(*) into n from painters where org_id = v_org and wa_phone_e164 = '+31611110001';
  if n <> 1 then raise exception 'T8 dedup painter (n=%)', n; end if;
  select count(*) into n from round_invites where round_id = v_rnd;
  if n <> 1 then raise exception 'T8 dedup invite (n=%)', n; end if;
  if not exists (select 1 from invite_responses ir join round_invites ri on ri.id = ir.invite_id
       where ri.round_id = v_rnd and ir.plaats = 'Baarn') then
    raise exception 'T8 address not updated on resubmit';
  end if;

  -- known roster phone => matched, no new painter row
  insert into painters (org_id, full_name, wa_phone_e164, wa_opt_in_status, is_active)
    values (v_org, 'Bekend', '+31611110002', 'opted_in', true);
  r := submit_public_response(slug, 'Bekend', '+31611110002',
        'Kerk', '2', '1000 AA', 'Nijkerk', array[vws]::date[], false);
  if (r->>'ok') <> 'true' or (r->>'matched') <> 'true' then raise exception 'T8 match: %', r; end if;
  select count(*) into n from painters where org_id = v_org;
  if n <> 2 then raise exception 'T8 match created a painter (n=%)', n; end if;

  r := get_round_by_slug('does-not-exist');
  if (r->>'ok') <> 'false' then raise exception 'T8 unknown slug not opaque: %', r; end if;

  raise notice 'T8 ok — public intake';
end $$;

-- T9 — ronde wordt automatisch benoemd naar zijn bezoekweek (db/011), zodat de
-- naam nooit kan tegenspreken wat de berekende datums zeggen.
do $$
declare v_org uuid; v_rnd uuid; s date; e date; lbl text;
begin
  insert into organizations (name) values ('smoke-label') returning id into v_org;
  insert into weekrondes (org_id, label, status, sent_at)
    values (v_org, 'zelf getypte onzin', 'collecting', now()) returning id into v_rnd;
  select visit_week_start, visit_week_end, label into s, e, lbl
    from weekrondes where id = v_rnd;
  if lbl is null or lbl not like 'Bezoekweek %' then
    raise exception 'T9 auto-label niet gezet: %', lbl;
  end if;
  if position(extract(day from s)::int::text in lbl) = 0 then
    raise exception 'T9 label bevat startdag niet: % (bezoekweek % t/m %)', lbl, s, e;
  end if;
  raise notice 'T9 ok — auto-label: %', lbl;
end $$;

-- T10 — Kees kiest de bezoekweek (db/012): moet een maandag zijn, moet ná de
-- deadline liggen, en een schilder kan geen dag doorgeven waarop hij niet komt.
do $$
declare
  v_org uuid; v_rnd uuid; vws date; ok boolean;
  v_p uuid; v_inv uuid; v_resp uuid;
begin
  insert into organizations (name) values ('smoke-week') returning id into v_org;

  -- geldig: maandag ruim na de deadline; Kees kan alleen ma (1) en wo (3)
  vws := date_trunc('week', (now() + interval '40 days'))::date;
  insert into weekrondes (org_id, status, sent_at, visit_week_start, visit_weekdays)
  values (v_org, 'collecting', now(), vws, array[1,3]::smallint[])
  returning id into v_rnd;
  if (select visit_week_end from weekrondes where id = v_rnd) <> vws + 4 then
    raise exception 'T10 visit_week_end is niet visit_week_start + 4';
  end if;

  -- een dinsdag als weekstart moet worden geweigerd
  ok := false;
  begin
    insert into weekrondes (org_id, status, sent_at, visit_week_start)
    values (v_org, 'draft', now(), vws + 1);
  exception when others then ok := true;
  end;
  if not ok then raise exception 'T10 niet-maandag werd geaccepteerd'; end if;

  -- een week die vóór de deadline begint moet worden geweigerd
  ok := false;
  begin
    insert into weekrondes (org_id, status, sent_at, visit_week_start)
    values (v_org, 'draft', now(), date_trunc('week', now())::date);
  exception when others then ok := true;
  end;
  if not ok then raise exception 'T10 week voor de deadline werd geaccepteerd'; end if;

  -- schilder mag ma (wel beschikbaar), maar geen di (niet beschikbaar)
  insert into painters (org_id, full_name, wa_phone_e164, wa_opt_in_status, is_active)
  values (v_org, 'Week Tester', '+31600009901', 'opted_in', true) returning id into v_p;
  insert into round_invites (round_id, painter_id, org_id, token_hash, status)
  values (v_rnd, v_p, v_org, 'smoke-week-hash', 'responded') returning id into v_inv;
  insert into invite_responses (invite_id, round_id, org_id, straat, huisnummer, plaats, geocode_status)
  values (v_inv, v_rnd, v_org, 'Straat', '1', 'Amersfoort', 'pending') returning id into v_resp;

  insert into response_workdays (response_id, round_id, work_date, weekday)
  values (v_resp, v_rnd, vws, 1);

  ok := false;
  begin
    insert into response_workdays (response_id, round_id, work_date, weekday)
    values (v_resp, v_rnd, vws + 1, 2);
  exception when others then ok := true;
  end;
  if not ok then raise exception 'T10 dag buiten beschikbaarheid werd geaccepteerd'; end if;

  raise notice 'T10 ok — bezoekweek-keuze en beschikbaarheid bewaakt';
end $$;

-- T11 — spookschilder-preventie + merge (db/013).
do $$
declare v_org uuid; v_rnd uuid; slug text; vws date; r jsonb; n int; src uuid; tgt uuid;
begin
  insert into organizations (name) values ('smoke-merge') returning id into v_org;
  insert into weekrondes (org_id, label, status, sent_at)
    values (v_org, 'merge', 'collecting', now()) returning id into v_rnd;
  select visit_week_start, public_slug into vws, slug from weekrondes where id = v_rnd;

  -- onbekend nummer zonder bevestiging => phone_unknown, GEEN painter aangemaakt
  r := submit_public_response(slug, 'Piet', '+31600055501',
        'Straat', '1', '1234 AB', 'Amersfoort', array[vws]::date[], false, false);
  if (r->>'reason') <> 'phone_unknown' then raise exception 'T11 gate: %', r; end if;
  select count(*) into n from painters where org_id = v_org and wa_phone_e164 = '+31600055501';
  if n <> 0 then raise exception 'T11 painter aangemaakt ondanks gate (n=%)', n; end if;

  -- met bevestiging => aangemaakt
  r := submit_public_response(slug, 'Piet', '+31600055501',
        'Straat', '1', '1234 AB', 'Amersfoort', array[vws]::date[], false, true);
  if (r->>'ok') <> 'true' then raise exception 'T11 allow_new: %', r; end if;

  -- roster-schilder (het "echte" record) + een spook op een typenummer
  insert into painters (org_id, full_name, wa_phone_e164, wa_opt_in_status, is_active)
    values (v_org, 'Piet de Echte', '+31600055500', 'opted_in', true) returning id into tgt;
  select id into src from painters where org_id = v_org and wa_phone_e164 = '+31600055501';

  -- simuleer een ingelogde beheerder (CI/lokaal heeft geen echte auth-sessie)
  create or replace function auth.uid() returns uuid language sql stable as $x$
    select '00000000-0000-0000-0000-0000000000aa'::uuid $x$;
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000aa', 'smoke-admin@test')
    on conflict do nothing;
  insert into app_admins (user_id, org_id) values ('00000000-0000-0000-0000-0000000000aa', v_org)
    on conflict do nothing;

  perform merge_painter(src, tgt);

  if exists (select 1 from painters where id = src) then raise exception 'T11 bron niet verwijderd'; end if;
  -- de reactie van het spook hangt nu aan het doel
  if not exists (
    select 1 from round_invites ri join invite_responses ir on ir.invite_id = ri.id
    where ri.round_id = v_rnd and ri.painter_id = tgt
  ) then raise exception 'T11 reactie niet verhuisd naar doel'; end if;

  raise notice 'T11 ok — spookpreventie + merge';
end $$;

select 'ALL SMOKE TESTS PASSED' as result;
