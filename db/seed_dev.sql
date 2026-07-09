-- ============================================================================
-- Dev seed — SYNTHETIC data only (CLAUDE.md rule 2).
-- Fake names, fake +3161000000xx numbers (never real), addresses around
-- Amersfoort. Two address clusters (2 painters on one site) so clustering
-- and the one-stop-per-address rule can be exercised.
-- NEVER run against production. Idempotent (fixed UUIDs + on conflict).
-- ============================================================================

insert into organizations (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Krofs (dev)')
on conflict (id) do nothing;

insert into painters (id, org_id, full_name, wa_phone_e164, wa_opt_in_status, wa_opt_in_at, consent_source)
values
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'Jan Jansen',        '+31610000001', 'opted_in', now(), 'admin_import'),
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001', 'Piet de Boer',      '+31610000002', 'opted_in', now(), 'admin_import'),
  ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000001', 'Mo Amrani',         '+31610000003', 'opted_in', now(), 'admin_import'),
  ('00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000001', 'Kees Visser',       '+31610000004', 'opted_in', now(), 'admin_import'),
  ('00000000-0000-0000-0000-000000000105', '00000000-0000-0000-0000-000000000001', 'Tomasz Kowal',      '+31610000005', 'opted_in', now(), 'admin_import'),
  ('00000000-0000-0000-0000-000000000106', '00000000-0000-0000-0000-000000000001', 'Sander Vos',        '+31610000006', 'opted_in', now(), 'admin_import'),
  ('00000000-0000-0000-0000-000000000107', '00000000-0000-0000-0000-000000000001', 'Ahmed Yildiz',      '+31610000007', 'opted_in', now(), 'admin_import'),
  ('00000000-0000-0000-0000-000000000108', '00000000-0000-0000-0000-000000000001', 'Bram Hendriks',     '+31610000008', 'opted_in', now(), 'admin_import'),
  ('00000000-0000-0000-0000-000000000109', '00000000-0000-0000-0000-000000000001', 'Lucas Meijer',      '+31610000009', 'opted_in', now(), 'admin_import'),
  ('00000000-0000-0000-0000-000000000110', '00000000-0000-0000-0000-000000000001', 'Erik Smit',         '+31610000010', 'opted_in', now(), 'admin_import'),
  ('00000000-0000-0000-0000-000000000111', '00000000-0000-0000-0000-000000000001', 'Danny Bakker',      '+31610000011', 'opted_in', now(), 'admin_import'),
  ('00000000-0000-0000-0000-000000000112', '00000000-0000-0000-0000-000000000001', 'Rico van Dijk',     '+31610000012', 'opted_in', now(), 'admin_import')
on conflict (id) do nothing;

-- Consent-audit rows for the seeded opt-ins (mirrors the CSV-importer behaviour).
insert into painter_consent_events (painter_id, org_id, event, source)
select p.id, p.org_id, 'opt_in', 'admin_import'
from painters p
where p.org_id = '00000000-0000-0000-0000-000000000001'
  and not exists (
    select 1 from painter_consent_events e
    where e.painter_id = p.id and e.event = 'opt_in'
  );

-- Reference for later manual testing (dry-run round):
--   cluster A: Jan + Piet          -> Nijverheidsweg 14, Amersfoort   (same site)
--   cluster B: Sander + Ahmed      -> Dorpsstraat 3, Soest            (same site)
--   spread:    others across Nijkerk, Leusden, Bunschoten, Baarn, Zeist
-- Addresses go in via invite_responses during a dry-run round, not seeded here,
-- so the full painter flow (/r/{token}) is what gets exercised.
