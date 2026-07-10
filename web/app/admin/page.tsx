import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const supabase = await supabaseServer();
  const { count } = await supabase
    .from("painters")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true);

  return (
    <div>
      <h1>Beheer</h1>
      <p className="intro">
        {count ?? 0} actieve schilder{(count ?? 0) === 1 ? "" : "s"} in de pool.
      </p>
      <div className="tiles">
        <Link className="tile" href="/admin/painters/import">
          <div className="tile-title">Schilders importeren</div>
          <div className="tile-sub">CSV plakken → controleren → toevoegen</div>
        </Link>
      </div>
    </div>
  );
}
