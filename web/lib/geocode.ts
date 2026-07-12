import "server-only";

// Address -> lat/lng. Google Geocoding API when GOOGLE_MAPS_API_KEY is set,
// otherwise a deterministic STUB (near Amersfoort) so the whole geocode sweep
// can be exercised without a key. Classifies into ok / ambiguous / not_found /
// error (transient) — the sweep maps those onto invite_responses.geocode_status.

export type GeoResult =
  | { status: "ok" | "ambiguous"; lat: number; lng: number; placeId?: string; confidence?: string; error?: string }
  | { status: "not_found" | "error"; lat?: number; lng?: number; error?: string };

export const IKEA_LAT = 52.2478;
export const IKEA_LNG = 5.4147;

export function hasGoogleKey(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function distanceKm(lat: number, lng: number): number {
  const R = 6371;
  const dLat = ((lat - IKEA_LAT) * Math.PI) / 180;
  const dLng = ((lng - IKEA_LNG) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((IKEA_LAT * Math.PI) / 180) *
      Math.cos((lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type Addr = { straat: string; huisnummer: string; postcode: string | null; plaats: string };

function fullAddress(a: Addr): string {
  return [`${a.straat} ${a.huisnummer}`.trim(), a.postcode ?? "", a.plaats, "Nederland"]
    .filter(Boolean)
    .join(", ");
}

function stub(a: Addr): GeoResult {
  if (!a.straat?.trim() || !a.plaats?.trim()) {
    return { status: "not_found", error: "stub: adres onvolledig" };
  }
  let h = 2166136261;
  for (const ch of fullAddress(a)) h = (Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0);
  const lat = IKEA_LAT - 0.09 + ((h % 1000) / 1000) * 0.18; // ~±10 km around IKEA
  const lng = IKEA_LNG - 0.12 + (((h >> 10) % 1000) / 1000) * 0.24;
  return { status: "ok", lat: r6(lat), lng: r6(lng), placeId: `stub_${h}`, confidence: "STUB" };
}

export async function geocodeAddress(a: Addr): Promise<GeoResult> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return stub(a);

  const region = process.env.GEOCODE_REGION || "nl";
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(fullAddress(a))}` +
    `&region=${region}&key=${key}`;

  let json: {
    status: string;
    results?: Array<{
      geometry?: { location?: { lat: number; lng: number }; location_type?: string };
      place_id?: string;
      partial_match?: boolean;
    }>;
    error_message?: string;
  };
  try {
    const res = await fetch(url, { cache: "no-store" });
    json = await res.json();
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "netwerkfout" };
  }

  switch (json.status) {
    case "OK": {
      const top = json.results?.[0];
      const loc = top?.geometry?.location;
      if (!loc) return { status: "error", error: "geen locatie in resultaat" };
      const ambiguous = top?.partial_match === true || (json.results?.length ?? 0) > 1;
      return {
        status: ambiguous ? "ambiguous" : "ok",
        lat: r6(loc.lat),
        lng: r6(loc.lng),
        placeId: top?.place_id,
        confidence: top?.geometry?.location_type,
        error: ambiguous ? "meerdere/gedeeltelijke match" : undefined,
      };
    }
    case "ZERO_RESULTS":
      return { status: "not_found", error: "niet gevonden" };
    case "OVER_QUERY_LIMIT":
    case "UNKNOWN_ERROR":
      return { status: "error", error: json.status }; // transient — retried
    default:
      // REQUEST_DENIED / INVALID_REQUEST etc.
      return { status: "error", error: json.error_message || json.status };
  }
}
