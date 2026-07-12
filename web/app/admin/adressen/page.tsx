import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";
import AdressenClient, { type QueueRow } from "./AdressenClient";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  straat: string;
  huisnummer: string;
  postcode: string | null;
  plaats: string;
  geocode_status: string;
  geocode_error: string | null;
  geocode_attempts: number;
  lat: number | null;
  lng: number | null;
  round_invites: unknown;
};

function painterName(ri: unknown): string {
  const inv = Array.isArray(ri) ? ri[0] : ri;
  const p = (inv as { painters?: unknown })?.painters;
  const painter = Array.isArray(p) ? p[0] : p;
  return (painter as { full_name?: string })?.full_name ?? "—";
}

export default async function AdressenPage() {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("invite_responses")
    .select(
      "id, straat, huisnummer, postcode, plaats, geocode_status, geocode_error, geocode_attempts, lat, lng, round_invites!inner(painters!inner(full_name))",
    )
    .or("geocode_status.in.(not_found,ambiguous),and(geocode_status.eq.error,geocode_attempts.gte.5)")
    .order("submitted_at");

  const rows: QueueRow[] = ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    name: painterName(r.round_invites),
    straat: r.straat,
    huisnummer: r.huisnummer,
    postcode: r.postcode,
    plaats: r.plaats,
    status: r.geocode_status,
    error: r.geocode_error,
    attempts: r.geocode_attempts,
    hasCoords: r.lat != null && r.lng != null,
  }));

  return (
    <div>
      <p className="crumb">
        <Link href="/admin">Beheer</Link> / Adressen controleren
      </p>
      <h1>Adressen controleren</h1>
      <p className="intro">
        Adressen die niet automatisch gevonden zijn. Corrigeer en probeer opnieuw,
        of gebruik het adres toch (als de kaartpositie klopt).
      </p>
      <AdressenClient rows={rows} />
    </div>
  );
}
