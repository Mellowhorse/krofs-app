-- ============================================================================
-- db/014 — Dagmaximum: schilders doorschuiven bij drukte.
-- ----------------------------------------------------------------------------
-- De route-builder verdeelde stops al over de beschikbare dagen, maar zonder
-- bovengrens. Met een maximum per dag schuift de builder flexibele schilders
-- (die meerdere dagen opgaven) door naar een rustiger dag, terwijl schilders
-- die maar op één — volle — dag kunnen tóch worden ingepland (met het "vol"-
-- label). Instelbaar per organisatie; standaard 10 bezoeken per dag.
-- ============================================================================
begin;

alter table organizations
  add column if not exists max_visits_per_day integer not null default 10
    check (max_visits_per_day > 0);

comment on column organizations.max_visits_per_day is
  'Streefmaximum aantal bezoeken (stops) per dag. De route-builder spreidt tot dit aantal en schuift flexibele schilders door naar een rustiger dag; wie alleen op een volle dag kan wordt tóch ingepland (dag krijgt het "vol"-label).';

commit;
