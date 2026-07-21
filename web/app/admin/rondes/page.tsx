import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";
import RondeClient, { type ActiveRound, type WeekOption } from "./RondeClient";

export const dynamic = "force-dynamic";

const TZ = "Europe/Amsterdam";
const nlDay = (d: Date) =>
  new Intl.DateTimeFormat("nl-NL", { timeZone: "UTC", day: "numeric" }).format(d);
const nlMonth = (d: Date) =>
  new Intl.DateTimeFormat("nl-NL", { timeZone: "UTC", month: "long" }).format(d);

function ymdUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// "ma 3 – vr 7 augustus" (of over een maandgrens: "ma 29 juni – vr 3 juli")
function weekLabel(monday: Date): string {
  const fri = new Date(monday);
  fri.setUTCDate(monday.getUTCDate() + 4);
  return monday.getUTCMonth() === fri.getUTCMonth()
    ? `ma ${nlDay(monday)} – vr ${nlDay(fri)} ${nlMonth(fri)}`
    : `ma ${nlDay(monday)} ${nlMonth(monday)} – vr ${nlDay(fri)} ${nlMonth(fri)}`;
}

// De bezoekweek moet ná de deadline beginnen (db/012 dwingt dit ook af).
// Eerste kiesbare week = eerste maandag na de sluitdatum.
function buildWeekOptions(deadlineDays: number): {
  weeks: WeekOption[];
  laatsteInvuldag: string;
} {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));

  const deadline = new Date(base);
  deadline.setUTCDate(base.getUTCDate() + deadlineDays + 1);
  const lastFill = new Date(deadline);
  lastFill.setUTCDate(deadline.getUTCDate() - 1);

  const isodow = ((deadline.getUTCDay() + 6) % 7) + 1;
  const firstMonday = new Date(deadline);
  firstMonday.setUTCDate(deadline.getUTCDate() + (8 - isodow));

  const weeks: WeekOption[] = [];
  for (let i = 0; i < 10; i++) {
    const mon = new Date(firstMonday);
    mon.setUTCDate(firstMonday.getUTCDate() + i * 7);
    weeks.push({ value: ymdUTC(mon), label: weekLabel(mon) });
  }
  return {
    weeks,
    laatsteInvuldag: `${nlDay(lastFill)} ${nlMonth(lastFill)}`,
  };
}

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

  // Kiesbare bezoekweken (alleen relevant als er géén ronde loopt)
  const { data: org } = await supabase
    .from("organizations")
    .select("deadline_days")
    .limit(1)
    .maybeSingle();
  const { weeks, laatsteInvuldag } = buildWeekOptions(org?.deadline_days ?? 5);

  return (
    <div>
      <p className="crumb">
        <Link href="/admin">Beheer</Link> / Rondes
      </p>
      <h1>Rondes</h1>
      <RondeClient active={active} weeks={weeks} laatsteInvuldag={laatsteInvuldag} />
    </div>
  );
}
