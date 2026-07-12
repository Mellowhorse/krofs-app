-- ============================================================================
-- Krofs schilderbezoek-planner — db/008 GEOCODING (Phase 3)
-- ----------------------------------------------------------------------------
-- The geocode sweep turns submitted addresses (invite_responses.geocode_status
-- = 'pending' | 'error') into lat/lng. All the columns already exist (db/002:
-- geocode_status/leased_until/attempts/provider/place_id/confidence/error, lat,
-- lng, manual_override). This migration only adds the atomic CLAIM used by the
-- service_role /tick sweep so concurrent workers never double-process a row.
--
--   claim_geocode_batch(limit, lease_seconds): leases a batch of claimable rows
--   (pending or transient-error, not overridden, lease expired, attempts < 5),
--   bumps geocode_attempts, and returns their address parts. The sweep geocodes
--   each and writes back ok/ambiguous/not_found/error + coords, clearing the
--   lease. Terminal states (ambiguous/not_found, or error at attempt 5) are NOT
--   re-claimed — they surface in the admin fix queue.
--
-- Requires db/001..007.
-- ============================================================================

begin;

create or replace function claim_geocode_batch(
  p_limit         int default 20,
  p_lease_seconds int default 120
)
returns table (
  id         uuid,
  straat     text,
  huisnummer text,
  postcode   text,
  plaats     text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update invite_responses ir
     set geocode_leased_until = now() + make_interval(secs => p_lease_seconds),
         geocode_attempts     = ir.geocode_attempts + 1
   where ir.id in (
     select ir2.id
     from invite_responses ir2
     join weekrondes w on w.id = ir2.round_id
     where ir2.geocode_status in ('pending', 'error')
       and ir2.manual_override = false
       and (ir2.geocode_leased_until is null or ir2.geocode_leased_until < now())
       and ir2.geocode_attempts < 5
       and w.status in ('collecting', 'closed', 'routing')
     order by ir2.submitted_at
     limit p_limit
     for update skip locked
   )
  returning ir.id, ir.straat, ir.huisnummer, ir.postcode, ir.plaats;
end;
$$;

revoke execute on function claim_geocode_batch(int, int) from public, anon, authenticated;
grant  execute on function claim_geocode_batch(int, int) to service_role;

comment on function claim_geocode_batch(int, int) is
  'Atomic geocode claim (service_role): leases a batch of pending/error responses (skip locked, attempts<5, lease expired), bumps attempts, returns their address parts for the sweep to geocode.';

commit;
