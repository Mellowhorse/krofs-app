import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";
import RondeClient, { type ActiveRound } from "./RondeClient";

export const dynamic = "force-dynamic";

export default async function RondesPage() {
  const supabase = await supabaseServer();

  const { data: round } = await supabase
    .from("weekrondes")
    .select("id, label, status, deadline_at, visit_week_start, visit_week_end")
    .in("status", ["sending", "collecting"])
    .maybeSingle();

  let active: ActiveRound | null = null;
  if (round) {
    const { count: invitesTotal } = await supabase
      .from("round_invites")
      .select("*", { count: "exact", head: true })
      .eq("round_id", round.id);
    const { count: respondedCount } = await supabase
      .from("round_invites")
      .select("*", { count: "exact", head: true })
      .eq("round_id", round.id)
      .eq("status", "responded");
    active = {
      id: round.id,
      label: round.label,
      deadline_at: round.deadline_at,
      visit_week_start: round.visit_week_start,
      visit_week_end: round.visit_week_end,
      invitesTotal: invitesTotal ?? 0,
      respondedCount: respondedCount ?? 0,
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
