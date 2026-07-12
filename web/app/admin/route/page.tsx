import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";
import RouteClient, { type DayView, type RoundView } from "./RouteClient";

export const dynamic = "force-dynamic";

const TZ = "Europe/Amsterdam";

function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat("nl-NL", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function dateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("nl-NL", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

type StopRow = {
  id: string;
  seq: number;
  dagdeel: string;
  planned_start: string;
  planned_end: string;
  straat: string;
  huisnummer: string;
  postcode: string | null;
  plaats: string;
  leg_distance_m: number | null;
  visited_at: string | null;
  route_stop_painters: Array<{ painter_name: string }>;
};

type DayRow = {
  id: string;
  visit_date: string;
  total_distance_m: number | null;
  total_duration_s: number | null;
  is_oversubscribed: boolean;
  google_maps_url: string | null;
  route_stops: StopRow[];
};

export default async function RoutePage() {
  const supabase = await supabaseServer();

  // Most recent round that has left the collecting phase.
  const { data: round } = await supabase
    .from("weekrondes")
    .select("id, label, status, visit_week_start, visit_week_end")
    .in("status", ["closed", "routing", "routed", "failed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!round) {
    return (
      <div>
        <p className="crumb">
          <Link href="/admin">Beheer</Link> / Route
        </p>
        <h1>Route</h1>
        <p className="intro">
          Er is nog geen afgesloten ronde. Zodra een ronde na de deadline sluit,
          kun je hier de route bouwen.
        </p>
      </div>
    );
  }

  const { data: plan } = await supabase
    .from("route_plans")
    .select("id, status, generated_at, unrouted_count, provider, error")
    .eq("round_id", round.id)
    .eq("is_current", true)
    .maybeSingle();

  let days: DayView[] = [];
  if (plan) {
    const { data: dayRows } = await supabase
      .from("route_days")
      .select(
        "id, visit_date, total_distance_m, total_duration_s, is_oversubscribed, google_maps_url, route_stops(id, seq, dagdeel, planned_start, planned_end, straat, huisnummer, postcode, plaats, leg_distance_m, visited_at, route_stop_painters(painter_name))",
      )
      .eq("route_plan_id", plan.id)
      .order("visit_date");

    days = ((dayRows ?? []) as DayRow[]).map((d) => ({
      id: d.id,
      dateLabel: dateLabel(d.visit_date),
      distanceKm: d.total_distance_m != null ? Math.round(d.total_distance_m / 100) / 10 : null,
      durationMin: d.total_duration_s != null ? Math.round(d.total_duration_s / 60) : null,
      oversubscribed: d.is_oversubscribed,
      mapsUrl: d.google_maps_url,
      stops: [...d.route_stops]
        .sort((a, b) => a.seq - b.seq)
        .map((s) => ({
          id: s.id,
          seq: s.seq,
          dagdeel: s.dagdeel,
          time: `${timeLabel(s.planned_start)}–${timeLabel(s.planned_end)}`,
          address: `${s.straat} ${s.huisnummer}${s.postcode ? `, ${s.postcode}` : ""} ${s.plaats}`,
          painters: s.route_stop_painters.map((p) => p.painter_name),
          legKm: s.leg_distance_m != null ? Math.round(s.leg_distance_m / 100) / 10 : null,
          visited: s.visited_at != null,
        })),
    }));
  }

  const view: RoundView = {
    roundId: round.id,
    label: round.label ?? "ronde",
    status: round.status,
    planStatus: plan?.status ?? null,
    provider: plan?.provider ?? null,
    unrouted: plan?.unrouted_count ?? 0,
    generatedAt: plan?.generated_at
      ? new Intl.DateTimeFormat("nl-NL", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(
          new Date(plan.generated_at),
        )
      : null,
    error: plan?.error ?? null,
  };

  return (
    <div>
      <p className="crumb">
        <Link href="/admin">Beheer</Link> / Route
      </p>
      <h1>Route — {view.label}</h1>
      <RouteClient round={view} days={days} />
    </div>
  );
}
