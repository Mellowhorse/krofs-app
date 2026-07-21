import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";
import RondeClient, { type ActiveRound } from "./RondeClient";

export const dynamic = "force-dynamic";

export default async function RondesPage() {
  const supabase = await supabaseServer();

  const { data: round } = await supabase
    .from("weekrondes")
    .select("id, label, status, deadline_at, visit_week_start, visit_week_end, public_slug")
    .in("status", ["sending", "collecting"])
    .maybeSingle();

  let active: ActiveRound | null = null;
  if (round) {
    // Roster = everyone we could expect an answer from.
    const { data: roster } = await supabase
      .from("painters")
      .select("id, full_name, wa_phone_e164")
      .eq("is_active", true)
      .neq("wa_opt_in_status", "opted_out")
      .order("full_name");

    // Reacted = invite flipped to 'responded' (covers "ik werk deze week niet").
    const { data: respondedRows } = await supabase
      .from("round_invites")
      .select("painter_id")
      .eq("round_id", round.id)
      .eq("status", "responded");

    const respondedIds = new Set((respondedRows ?? []).map((r) => r.painter_id));
    const rosterList = roster ?? [];
    const base = process.env.PUBLIC_BASE_URL || "http://localhost:3100";

    active = {
      id: round.id,
      label: round.label,
      deadline_at: round.deadline_at,
      visit_week_start: round.visit_week_start,
      visit_week_end: round.visit_week_end,
      rosterTotal: rosterList.length,
      respondedCount: respondedIds.size,
      missing: rosterList
        .filter((p) => !respondedIds.has(p.id))
        .map((p) => ({ id: p.id, name: p.full_name, phone: p.wa_phone_e164 ?? "" })),
      shareUrl: round.public_slug ? `${base}/u/${round.public_slug}` : null,
    };
  }

  return (
    <div>
      <p className="crumb">
        <Link href="/admin">Beheer</Link> / Rondes
      </p>
      <h1>Rondes</h1>
      <RondeClient active={active} />
    </div>
  );
}
