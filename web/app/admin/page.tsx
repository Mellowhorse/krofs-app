import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const supabase = await supabaseServer();
  const { count: painters } = await supabase
    .from("painters")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true);
  const { data: round } = await supabase
    .from("weekrondes")
    .select("label, deadline_at")
    .in("status", ["sending", "collecting"])
    .maybeSingle();
  // Een gesloten (of mislukte) ronde die nog geen route heeft = klaar om te plannen.
  const { data: planbaar } = await supabase
    .from("weekrondes")
    .select("label")
    .in("status", ["closed", "failed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { count: reviewCount } = await supabase
    .from("invite_responses")
    .select("*", { count: "exact", head: true })
    .or("geocode_status.in.(not_found,ambiguous),and(geocode_status.eq.error,geocode_attempts.gte.5)");

  const deadlinePassed =
    round?.deadline_at != null && new Date(round.deadline_at).getTime() < Date.now();

  return (
    <div>
      <h1>Beheer</h1>
      <p className="intro">
        {painters ?? 0} actieve schilder{(painters ?? 0) === 1 ? "" : "s"} ·{" "}
        {round ? `ronde "${round.label}" loopt` : "geen actieve ronde"}
      </p>

      {deadlinePassed ? (
        <Link className="banner-link" href="/admin/rondes">
          De uitvraag is voorbij de deadline — sluit &lsquo;m om de route te kunnen bouwen.
        </Link>
      ) : planbaar ? (
        <Link className="banner-link" href="/admin/route">
          Ronde &ldquo;{planbaar.label}&rdquo; is gesloten — route nog te bouwen →
        </Link>
      ) : null}

      <div className="tiles">
        <Link className="tile" href="/admin/rondes">
          <div className="tile-title">Rondes</div>
          <div className="tile-sub">Ronde starten en links versturen</div>
        </Link>
        <Link className="tile" href="/admin/painters">
          <div className="tile-title">Schilders</div>
          <div className="tile-sub">Toevoegen, bewerken of archiveren</div>
        </Link>
        <Link className="tile" href="/admin/reacties">
          <div className="tile-title">Reacties</div>
          <div className="tile-sub">Wie gaf zijn beschikbaarheid door — en wie nog niet</div>
        </Link>
        <Link className="tile" href="/admin/adressen">
          <div className="tile-title">
            Adressen controleren
            {reviewCount ? <span className="badge">{reviewCount}</span> : null}
          </div>
          <div className="tile-sub">Niet-gevonden adressen corrigeren</div>
        </Link>
        <Link className="tile" href="/admin/route">
          <div className="tile-title">
            Route
            {planbaar ? <span className="badge badge-accent">te plannen</span> : null}
          </div>
          <div className="tile-sub">Route bouwen en afvinken wie je gezien hebt</div>
        </Link>
      </div>
    </div>
  );
}
