import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";
import PaintersClient, { type PainterRow } from "./PaintersClient";

export const dynamic = "force-dynamic";

export default async function PaintersPage() {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("painters")
    .select("id, full_name, wa_phone_e164, is_active, consent_source")
    .order("is_active", { ascending: false })
    .order("full_name");

  const painters: PainterRow[] = (data ?? []).map((p) => ({
    id: p.id,
    name: p.full_name,
    phone: p.wa_phone_e164 ?? "",
    active: p.is_active,
    selfReport: p.consent_source === "self_report",
  }));

  const actief = painters.filter((p) => p.active).length;

  return (
    <div>
      <p className="crumb">
        <Link href="/admin">Beheer</Link> / Schilders
      </p>
      <h1>Schilders</h1>
      <p className="intro">
        {actief} actieve schilder{actief === 1 ? "" : "s"}. Bewerk een naam of nummer,
        archiveer wie weg is, of verwijder een verkeerde invoer.{" "}
        <Link href="/admin/painters/import">+ Schilders importeren</Link>
      </p>
      <PaintersClient painters={painters} />
    </div>
  );
}
