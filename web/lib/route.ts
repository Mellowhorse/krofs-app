import "server-only";

import { admin } from "./supabaseAdmin";
import { IKEA_LAT, IKEA_LNG, haversineMeters, hasGoogleKey } from "./geocode";

// ---------------------------------------------------------------------------
// Phase 4 route builder.
//
// Turns a closed round's routable responses into a per-day driving plan from a
// fixed start (IKEA Vathorst). Addresses are CLUSTERED: everyone at one address
// becomes a single 30-minute group stop. Per day the stops are ordered nearest-
// neighbour from IKEA and packed into wall-clock slots (ochtend before middag).
//
// Travel legs come from the Google Routes API when GOOGLE_MAPS_API_KEY is set,
// otherwise from a haversine stub (straight line * road factor) so the whole
// pipeline runs without a key — same pattern as lib/geocode.
// ---------------------------------------------------------------------------

const VISIT_MINUTES = 30;
const ROAD_FACTOR = 1.3; // straight-line -> road distance fudge for the stub
const STUB_SPEED_KMH = 45; // effective NL mixed-road speed for the stub

type Member = {
  response_id: string;
  painter_id: string;
  painter_name: string;
  workdays: Set<string>; // YYYY-MM-DD
};

type Cluster = {
  key: string;
  lat: number;
  lng: number;
  straat: string;
  huisnummer: string;
  postcode: string | null;
  plaats: string;
  members: Member[];
};

// Een stop = één adres op één dag, met de schilders die dáár die dag bezocht
// worden. Een adres kan zo over meerdere dagen worden gesplitst als de schilders
// er niet allemaal op dezelfde dag zijn.
type StopGroup = {
  key: string;
  lat: number;
  lng: number;
  straat: string;
  huisnummer: string;
  postcode: string | null;
  plaats: string;
  members: Member[];
  date: string; // yyyy-mm-dd
};

type PlacedStop = StopGroup & {
  seq: number;
  dagdeel: "ochtend" | "middag";
  planned_start: string; // ISO
  planned_end: string; // ISO
  leg_distance_m: number;
  leg_duration_s: number;
};

export type BuildResult = {
  ok: boolean;
  planId?: string;
  days?: number;
  stops?: number;
  painters?: number;
  unrouted?: number;
  provider?: string;
  error?: string;
};

// ---- time helpers (Europe/Amsterdam, DST-safe) ----------------------------

function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value;
  const asUTC = Date.UTC(
    +m.year,
    +m.month - 1,
    +m.day,
    +m.hour === 24 ? 0 : +m.hour,
    +m.minute,
    +m.second,
  );
  return (asUTC - date.getTime()) / 60000;
}

// A local wall-clock time (date + minutes past midnight) -> the UTC instant.
function localInstant(ymd: string, minutes: number, tz: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const guess = new Date(Date.UTC(y, mo - 1, d, hh, mm, 0));
  const off = tzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - off * 60000);
}

function hhmmToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

// ---- travel legs ----------------------------------------------------------

function stubLeg(aLat: number, aLng: number, bLat: number, bLng: number) {
  const straight = haversineMeters(aLat, aLng, bLat, bLng);
  const distance_m = Math.round(straight * ROAD_FACTOR);
  const duration_s = Math.round(distance_m / ((STUB_SPEED_KMH * 1000) / 3600));
  return { distance_m, duration_s };
}

async function googleLeg(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): Promise<{ distance_m: number; duration_s: number } | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: aLat, longitude: aLng } } },
        destination: { location: { latLng: { latitude: bLat, longitude: bLng } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
      }),
    });
    const json = await res.json();
    const r = json?.routes?.[0];
    if (!r) return null;
    const duration_s = Number(String(r.duration ?? "0").replace("s", "")) || 0;
    return { distance_m: Number(r.distanceMeters) || 0, duration_s };
  } catch {
    return null; // fall back to the stub on any failure
  }
}

async function leg(aLat: number, aLng: number, bLat: number, bLng: number) {
  return (await googleLeg(aLat, aLng, bLat, bLng)) ?? stubLeg(aLat, aLng, bLat, bLng);
}

// ---- clustering + per-day placement ---------------------------------------

function clusterResponses(
  rows: Array<{
    response_id: string;
    painter_id: string;
    painter_name: string;
    straat: string;
    huisnummer: string;
    postcode: string | null;
    plaats: string;
    lat: number;
    lng: number;
    place_id: string | null;
    workdays: string[];
  }>,
): Cluster[] {
  const byKey = new Map<string, Cluster>();
  for (const r of rows) {
    const key = r.place_id?.trim()
      ? r.place_id.trim()
      : `${r.lat.toFixed(4)},${r.lng.toFixed(4)}`;
    let c = byKey.get(key);
    if (!c) {
      c = {
        key,
        lat: r.lat,
        lng: r.lng,
        straat: r.straat,
        huisnummer: r.huisnummer,
        postcode: r.postcode,
        plaats: r.plaats,
        members: [],
      };
      byKey.set(key, c);
    }
    c.members.push({
      response_id: r.response_id,
      painter_id: r.painter_id,
      painter_name: r.painter_name,
      workdays: new Set(r.workdays),
    });
  }
  return [...byKey.values()];
}

// Assign every painter to exactly one of their workdays and turn clusters into
// per-day stops. Painters at the same address on the same day become one group
// stop; a cluster whose members share no day is split across days. Ties on
// coverage go to the LEAST-loaded day so stops spread over the admin's available
// days instead of all piling on the earliest one.
function assignStops(clusters: Cluster[], cap: number): StopGroup[] {
  const dayLoad = new Map<string, number>(); // stops already placed per day
  const out: StopGroup[] = [];

  for (const c of clusters) {
    let remaining = [...c.members];
    while (remaining.length) {
      const tally = new Map<string, number>();
      for (const m of remaining)
        for (const d of m.workdays) tally.set(d, (tally.get(d) ?? 0) + 1);
      if (tally.size === 0) break; // members without any workday (defensive)

      // Choose the day for this group. Keep same-address painters together
      // (max coverage first), then prefer a day still under the cap so the
      // busy days shed their flexible painters, then the least-loaded day.
      let day = "";
      let bestN = -1;
      let bestUnder = false;
      let bestLoad = 0;
      for (const [d, n] of tally) {
        const load = dayLoad.get(d) ?? 0;
        const under = load < cap;
        let better = false;
        if (day === "") better = true;
        else if (n > bestN) better = true;
        else if (n === bestN) {
          if (under && !bestUnder) better = true;
          else if (under === bestUnder) {
            if (load < bestLoad) better = true;
            else if (load === bestLoad && d < day) better = true;
          }
        }
        if (better) {
          day = d;
          bestN = n;
          bestUnder = under;
          bestLoad = load;
        }
      }

      const group = remaining.filter((m) => m.workdays.has(day));
      out.push({
        key: c.key,
        lat: c.lat,
        lng: c.lng,
        straat: c.straat,
        huisnummer: c.huisnummer,
        postcode: c.postcode,
        plaats: c.plaats,
        members: group,
        date: day,
      });
      dayLoad.set(day, (dayLoad.get(day) ?? 0) + 1);
      const chosen = new Set(group);
      remaining = remaining.filter((m) => !chosen.has(m));
    }
  }
  return out;
}

// Nearest-neighbour order from IKEA, then pack into wall-clock slots.
async function placeDay(
  clusters: StopGroup[],
  date: string,
  tz: string,
  dayStartMin: number,
  splitMin: number,
): Promise<{ stops: PlacedStop[]; totalDist: number; endMin: number }> {
  const remaining = [...clusters];
  const ordered: StopGroup[] = [];
  let curLat = IKEA_LAT;
  let curLng = IKEA_LNG;
  while (remaining.length) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMeters(curLat, curLng, remaining[i].lat, remaining[i].lng);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const next = remaining.splice(bi, 1)[0];
    ordered.push(next);
    curLat = next.lat;
    curLng = next.lng;
  }

  const stops: PlacedStop[] = [];
  let prevLat = IKEA_LAT;
  let prevLng = IKEA_LNG;
  let t = dayStartMin;
  let totalDist = 0;
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    const l = await leg(prevLat, prevLng, c.lat, c.lng);
    totalDist += l.distance_m;
    t += Math.ceil(l.duration_s / 60);
    const startMin = t;
    const endMin = t + VISIT_MINUTES;
    stops.push({
      ...c,
      seq: i + 1,
      dagdeel: startMin < splitMin ? "ochtend" : "middag",
      planned_start: localInstant(date, startMin, tz).toISOString(),
      planned_end: localInstant(date, endMin, tz).toISOString(),
      leg_distance_m: l.distance_m,
      leg_duration_s: l.duration_s,
    });
    t = endMin;
    prevLat = c.lat;
    prevLng = c.lng;
  }
  return { stops, totalDist, endMin: t };
}

function mapsUrl(stops: PlacedStop[]): string {
  const pt = (lat: number, lng: number) => `${lat},${lng}`;
  const origin = pt(IKEA_LAT, IKEA_LNG);
  if (stops.length === 0) return `https://www.google.com/maps/?q=${origin}`;
  const dest = pt(stops[stops.length - 1].lat, stops[stops.length - 1].lng);
  const mid = stops.slice(0, -1).map((s) => pt(s.lat, s.lng));
  const params = new URLSearchParams({ api: "1", origin, destination: dest });
  let url = `https://www.google.com/maps/dir/?${params.toString()}`;
  if (mid.length) url += `&waypoints=${encodeURIComponent(mid.join("|"))}`;
  return url;
}

// ---------------------------------------------------------------------------

export async function buildRoute(roundId: string): Promise<BuildResult> {
  const provider = hasGoogleKey() ? "google_routes" : "stub";

  // Org settings for the wall-clock window.
  const { data: round } = await admin
    .from("weekrondes")
    .select("id, org_id, organizations(timezone, day_start_local, dagdeel_split_local, max_working_minutes, max_visits_per_day)")
    .eq("id", roundId)
    .single();
  if (!round) return { ok: false, error: "ronde niet gevonden" };
  type OrgShape = {
    timezone: string;
    day_start_local: string;
    dagdeel_split_local: string;
    max_working_minutes: number;
    max_visits_per_day: number;
  };
  const rawOrg = (round as unknown as { organizations: OrgShape | OrgShape[] }).organizations;
  const org = Array.isArray(rawOrg) ? rawOrg[0] : rawOrg;
  const tz = org.timezone;
  const dayStartMin = hhmmToMinutes(org.day_start_local);
  const splitMin = hhmmToMinutes(org.dagdeel_split_local);
  const maxMin = org.max_working_minutes;
  const cap = org.max_visits_per_day || 10;

  // Routable responses (geocode ok OR admin override) with >=1 workday.
  const { data: resp } = await admin
    .from("invite_responses")
    .select("id, straat, huisnummer, postcode, plaats, lat, lng, geocode_place_id, geocode_status, manual_override, round_invites!inner(painter_id, painters!inner(full_name)), response_workdays(work_date)")
    .eq("round_id", roundId);

  const routable = (resp ?? []).filter(
    (r: Record<string, unknown>) =>
      (r.geocode_status === "ok" || r.manual_override === true) &&
      r.lat != null &&
      r.lng != null &&
      Array.isArray(r.response_workdays) &&
      (r.response_workdays as unknown[]).length > 0,
  );

  const unrouted = (resp ?? []).filter(
    (r: Record<string, unknown>) =>
      Array.isArray(r.response_workdays) &&
      (r.response_workdays as unknown[]).length > 0 &&
      !(r.geocode_status === "ok" || r.manual_override === true),
  ).length;

  if (routable.length === 0) {
    return { ok: false, error: "geen routeerbare adressen in deze ronde" };
  }

  const rows = routable.map((r: Record<string, unknown>) => {
    const inv = r.round_invites as { painter_id: string; painters: { full_name: string } };
    return {
      response_id: r.id as string,
      painter_id: inv.painter_id,
      painter_name: inv.painters.full_name,
      straat: r.straat as string,
      huisnummer: r.huisnummer as string,
      postcode: (r.postcode as string) ?? null,
      plaats: r.plaats as string,
      lat: r.lat as number,
      lng: r.lng as number,
      place_id: (r.geocode_place_id as string) ?? null,
      workdays: (r.response_workdays as Array<{ work_date: string }>).map((w) => w.work_date),
    };
  });

  const clusters = clusterResponses(rows);

  // Turn clusters into per-day stops, spread over the admin's available days,
  // then group by date.
  const byDate = new Map<string, StopGroup[]>();
  for (const s of assignStops(clusters, cap)) {
    if (!s.date) continue;
    const list = byDate.get(s.date) ?? [];
    list.push(s);
    byDate.set(s.date, list);
  }
  const dates = [...byDate.keys()].sort();

  // Open a fresh building plan (round -> routing).
  const { data: planId, error: startErr } = await admin.rpc("start_route_build", {
    p_round_id: roundId,
    p_provider: provider,
  });
  if (startErr || !planId) return { ok: false, error: startErr?.message ?? "start_route_build faalde" };

  try {
    let stopTotal = 0;
    let painterTotal = 0;

    for (const date of dates) {
      const dayClusters = byDate.get(date)!;
      const { stops, totalDist, endMin } = await placeDay(dayClusters, date, tz, dayStartMin, splitMin);
      const durationS = (endMin - dayStartMin) * 60;
      // "vol" = boven het dagmaximum (aantal) óf boven de werkdag (tijd)
      const oversub = stops.length > cap || endMin - dayStartMin > maxMin;

      const { data: dayRow, error: dayErr } = await admin
        .from("route_days")
        .insert({
          route_plan_id: planId,
          round_id: roundId,
          visit_date: date,
          start_lat: IKEA_LAT,
          start_lng: IKEA_LNG,
          total_distance_m: totalDist,
          total_duration_s: durationS,
          is_oversubscribed: oversub,
          google_maps_url: mapsUrl(stops),
        })
        .select("id")
        .single();
      if (dayErr || !dayRow) throw new Error(`route_days insert: ${dayErr?.message}`);

      for (const s of stops) {
        const { data: stopRow, error: stopErr } = await admin
          .from("route_stops")
          .insert({
            route_day_id: dayRow.id,
            route_plan_id: planId,
            seq: s.seq,
            dagdeel: s.dagdeel,
            planned_start: s.planned_start,
            planned_end: s.planned_end,
            lat: s.lat,
            lng: s.lng,
            cluster_key: `${s.key}@${date}`,
            straat: s.straat,
            huisnummer: s.huisnummer,
            postcode: s.postcode,
            plaats: s.plaats,
            leg_distance_m: s.leg_distance_m,
            leg_duration_s: s.leg_duration_s,
          })
          .select("id")
          .single();
        if (stopErr || !stopRow) throw new Error(`route_stops insert: ${stopErr?.message}`);
        stopTotal++;

        const children = s.members.map((m) => ({
          stop_id: stopRow.id,
          route_plan_id: planId,
          response_id: m.response_id,
          painter_id: m.painter_id,
          painter_name: m.painter_name,
        }));
        const { error: childErr } = await admin.from("route_stop_painters").insert(children);
        if (childErr) throw new Error(`route_stop_painters insert: ${childErr.message}`);
        painterTotal += children.length;
      }
    }

    await admin.rpc("finalize_route_build", { p_plan_id: planId, p_unrouted: unrouted });

    return {
      ok: true,
      planId: planId as string,
      days: dates.length,
      stops: stopTotal,
      painters: painterTotal,
      unrouted,
      provider,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "onbekende bouwfout";
    await admin.rpc("fail_route_build", { p_plan_id: planId, p_error: msg });
    return { ok: false, error: msg };
  }
}
