-- ============================================================================
-- db/016 — Instellingen die nog in de code vastzaten.
-- ----------------------------------------------------------------------------
-- De bezoekduur (30 min) en het vertrekpunt (IKEA Vathorst) stonden hard in
-- lib/route.ts. Ze horen bij de organisatie, zodat de beheerder ze via het
-- instellingen-scherm kan wijzigen. Defaults = het huidige gedrag, dus voor
-- bestaande rondes verandert er niets.
-- ============================================================================
begin;

alter table organizations
  add column if not exists visit_minutes integer not null default 30
    check (visit_minutes between 5 and 240),
  add column if not exists start_label text not null default 'IKEA Vathorst, Amersfoort',
  add column if not exists start_lat double precision not null default 52.2478
    check (start_lat between -90 and 90),
  add column if not exists start_lng double precision not null default 5.4147
    check (start_lng between -180 and 180);

comment on column organizations.visit_minutes is
  'Geplande duur van één bezoek in minuten (was hardcoded 30).';
comment on column organizations.start_label is
  'Leesbaar vertrekadres waar elke routedag begint.';

commit;
