-- ============================================================================
-- db/011 — Rondes worden automatisch benoemd naar hun bezoekweek.
-- ----------------------------------------------------------------------------
-- De label was vrije tekst die de beheerder intypte, terwijl deadline en
-- bezoekweek door weekronde_anchors uit sent_at worden BEREKEND. Dat liep uit
-- elkaar: een ronde heette "Week 21-28 augustus" terwijl de bezoekweek 27-31
-- juli was. De naam wordt nu bij de bron afgeleid, dus hij kan niet meer
-- tegenspreken wat er in het scherm staat.
--
-- Triggervolgorde: BEFORE-triggers vuren alfabetisch, dus
-- trg_weekronde_anchors (berekent visit_week_*) draait vóór trg_weekronde_label.
-- ============================================================================
begin;

create or replace function weekronde_label()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  maanden text[] := array[
    'januari','februari','maart','april','mei','juni',
    'juli','augustus','september','oktober','november','december'
  ];
  s date := NEW.visit_week_start;
  e date := NEW.visit_week_end;
begin
  -- Geen bezoekweek (concept-ronde, nog niet verstuurd) => laat de label met rust.
  if s is null or e is null then
    return NEW;
  end if;

  if extract(month from s) = extract(month from e) then
    NEW.label := format('Bezoekweek %s–%s %s',
      extract(day from s)::int, extract(day from e)::int,
      maanden[extract(month from e)::int]);
  else
    NEW.label := format('Bezoekweek %s %s – %s %s',
      extract(day from s)::int, maanden[extract(month from s)::int],
      extract(day from e)::int, maanden[extract(month from e)::int]);
  end if;

  return NEW;
end;
$$;

create trigger trg_weekronde_label before insert or update on weekrondes
  for each row execute function weekronde_label();

comment on function weekronde_label() is
  'Benoemt een ronde naar zijn berekende bezoekweek ("Bezoekweek 27–31 juli"), zodat de naam nooit kan tegenspreken wat de datums zeggen.';

-- Bestaande rondes hernoemen (de trigger doet de rest).
update weekrondes set label = label where visit_week_start is not null;

commit;
