import "server-only";

// Address -> lat/lng. Provider order: GEOCODE_PROVIDER=stub (offline tests) ->
// Google Geocoding API when GOOGLE_MAPS_API_KEY is set -> otherwise PDOK
// Locatieserver (Kadaster, free, no API key, NL only). Classifies into
// ok / ambiguous / not_found / error (transient) — the sweep maps those onto
// invite_responses.geocode_status. lookupByPostcode() powers the form's
// postcode+huisnummer -> verified address autofill.

export type GeoResult =
  | { status: "ok" | "ambiguous"; lat: number; lng: number; placeId?: string; confidence?: string; error?: string }
  | { status: "not_found" | "error"; lat?: number; lng?: number; error?: string };

export const IKEA_LAT = 52.2478;
export const IKEA_LNG = 5.4147;

export function hasGoogleKey(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

// Haversine great-circle distance between two points, in metres.
export function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Distance from the fixed start point (IKEA Vathorst), in km. Used for the
// far-from-start review flag during geocoding.
export function distanceKm(lat: number, lng: number): number {
  return haversineMeters(IKEA_LAT, IKEA_LNG, lat, lng) / 1000;
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

async function google(a: Addr): Promise<GeoResult> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
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
      return { status: "error", error: json.error_message || json.status };
  }
}

// ---- PDOK Locatieserver (Kadaster; free, no key, NL) -----------------------

const PDOK_BASE = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";

type PdokDoc = {
  weergavenaam?: string;
  centroide_ll?: string; // "POINT(lng lat)"
  straatnaam?: string;
  huisnummer?: number;
  huisletter?: string;
  huisnummertoevoeging?: string;
  postcode?: string;
  woonplaatsnaam?: string;
};

function normPostcode(pc: string | null): string {
  return (pc ?? "").replace(/\s+/g, "").toUpperCase();
}
function houseDigits(nr: string): string {
  return /\d+/.exec(nr ?? "")?.[0] ?? "";
}
function parseLatLng(centroide?: string): { lat: number; lng: number } | null {
  const m = /POINT\(([-\d.]+)\s+([-\d.]+)\)/.exec(centroide ?? "");
  return m ? { lng: parseFloat(m[1]), lat: parseFloat(m[2]) } : null;
}

// Exact address by postcode + house number (the reliable NL key). Returns the
// best-matching adres doc, or null. Prefers an exact house-number+letter match.
async function pdokExact(postcode: string, huisnummer: string): Promise<PdokDoc | null> {
  const pc = normPostcode(postcode);
  const nr = houseDigits(huisnummer);
  if (!/^\d{4}[A-Z]{2}$/.test(pc) || !nr) return null;
  const url =
    `${PDOK_BASE}?q=*:*&rows=8` +
    `&fl=weergavenaam,centroide_ll,straatnaam,huisnummer,huisletter,huisnummertoevoeging,postcode,woonplaatsnaam` +
    `&fq=${encodeURIComponent("type:adres")}` +
    `&fq=${encodeURIComponent(`postcode:${pc}`)}` +
    `&fq=${encodeURIComponent(`huisnummer:${nr}`)}`;
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json();
  const docs: PdokDoc[] = json?.response?.docs ?? [];
  if (docs.length === 0) return null;
  const suffix = (huisnummer.match(/\d+\s*(.*)$/)?.[1] ?? "").replace(/\s+/g, "").toLowerCase();
  if (suffix) {
    const exact = docs.find(
      (d) =>
        `${d.huisletter ?? ""}${d.huisnummertoevoeging ?? ""}`.replace(/\s+/g, "").toLowerCase() ===
        suffix,
    );
    if (exact) return exact;
  }
  return docs[0];
}

export type AddressLookup =
  | { ok: true; straat: string; huisnummer: string; postcode: string; plaats: string; lat: number; lng: number }
  | { ok: false; reason: "invalid" | "not_found" | "error" };

// Form-facing: postcode + huisnummer -> a verified, complete address.
export async function lookupByPostcode(
  postcode: string,
  huisnummer: string,
): Promise<AddressLookup> {
  const pc = normPostcode(postcode);
  if (!/^\d{4}[A-Z]{2}$/.test(pc) || !houseDigits(huisnummer)) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const doc = await pdokExact(pc, huisnummer);
    if (!doc) return { ok: false, reason: "not_found" };
    const ll = parseLatLng(doc.centroide_ll);
    if (!ll) return { ok: false, reason: "error" };
    const nr =
      `${doc.huisnummer ?? houseDigits(huisnummer)}${doc.huisletter ?? ""}` +
      (doc.huisnummertoevoeging ? `-${doc.huisnummertoevoeging}` : "");
    return {
      ok: true,
      straat: doc.straatnaam ?? "",
      huisnummer: nr,
      postcode: `${pc.slice(0, 4)} ${pc.slice(4)}`,
      plaats: doc.woonplaatsnaam ?? "",
      lat: r6(ll.lat),
      lng: r6(ll.lng),
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}

async function pdok(a: Addr): Promise<GeoResult> {
  try {
    if (a.postcode && a.huisnummer) {
      const doc = await pdokExact(a.postcode, a.huisnummer);
      const ll = doc && parseLatLng(doc.centroide_ll);
      if (ll) {
        return { status: "ok", lat: r6(ll.lat), lng: r6(ll.lng), placeId: doc?.weergavenaam, confidence: "pdok:exact" };
      }
    }
    // fuzzy fallback (manual entry, no/invalid postcode) — less trustworthy
    const q = [`${a.straat} ${a.huisnummer}`.trim(), a.postcode ?? "", a.plaats].filter(Boolean).join(" ");
    const url = `${PDOK_BASE}?q=${encodeURIComponent(q)}&rows=1&fl=weergavenaam,centroide_ll&fq=${encodeURIComponent("type:adres")}`;
    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json();
    const doc: PdokDoc | undefined = json?.response?.docs?.[0];
    if (!doc) return { status: "not_found", error: "adres niet gevonden" };
    const ll = parseLatLng(doc.centroide_ll);
    if (!ll) return { status: "error", error: "geen coördinaat" };
    // no exact postcode hit => flag for review
    return { status: "ambiguous", lat: r6(ll.lat), lng: r6(ll.lng), placeId: doc.weergavenaam, confidence: "pdok:fuzzy", error: "geen exacte postcode-match" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "netwerkfout" };
  }
}

export async function geocodeAddress(a: Addr): Promise<GeoResult> {
  if (process.env.GEOCODE_PROVIDER === "stub") return stub(a);
  if (process.env.GOOGLE_MAPS_API_KEY) return google(a);
  return pdok(a);
}
