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
    .select("label")
    .in("status", ["sending", "collecting"])
    .maybeSingle();

  return (
    <div>
      <h1>Beheer</h1>
      <p className="intro">
        {painters ?? 0} actieve schilder{(painters ?? 0) === 1 ? "" : "s"} ·{" "}
        {round ? `ronde "${round.label}" loopt` : "geen actieve ronde"}
      </p>
      <div className="tiles">
        <Link className="tile" href="/admin/rondes">
          <div className="tile-title">Rondes</div>
          <div className="tile-sub">Ronde starten en links versturen</div>
        </Link>
        <Link className="tile" href="/admin/painters/import">
          <div className="tile-title">Schilders importeren</div>
          <div className="tile-sub">CSV plakken → controleren → toevoegen</div>
        </Link>
      </div>
    </div>
  );
}
