import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";
import InstellingenClient, { type Settings } from "./InstellingenClient";

export const dynamic = "force-dynamic";

const addMin = (t: string, mins: number) => {
  const [h, m] = t.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

export default async function InstellingenPage() {
  const supabase = await supabaseServer();
  const { data: org } = await supabase
    .from("organizations")
    .select(
      "visit_minutes, day_start_local, max_working_minutes, max_visits_per_day, deadline_days, start_label, start_lat, start_lng",
    )
    .limit(1)
    .maybeSingle();

  const dayStart = (org?.day_start_local ?? "08:00:00").slice(0, 5);
  const settings: Settings = {
    visitMinutes: org?.visit_minutes ?? 30,
    dayStart,
    dayEnd: addMin(dayStart, org?.max_working_minutes ?? 480),
    maxVisits: org?.max_visits_per_day ?? 10,
    deadlineDays: org?.deadline_days ?? 5,
    startLabel: org?.start_label ?? "IKEA Vathorst, Amersfoort",
    startLat: org?.start_lat ?? 52.2478,
    startLng: org?.start_lng ?? 5.4147,
  };

  return (
    <div>
      <p className="crumb">
        <Link href="/admin">Beheer</Link> / Instellingen
      </p>
      <h1>Instellingen</h1>
      <p className="intro">
        Deze gelden vanaf de volgende route die je bouwt. Bestaande routes blijven zoals ze zijn.
      </p>
      <InstellingenClient initial={settings} />
    </div>
  );
}
