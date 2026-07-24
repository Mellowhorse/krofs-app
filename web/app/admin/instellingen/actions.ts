"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabaseServer";
import { lookupByPostcode } from "@/lib/geocode";

async function adminOrgId(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from("app_admins")
    .select("org_id")
    .eq("user_id", user.id)
    .maybeSingle();
  return data?.org_id ?? null;
}

const toMin = (t: string) => {
  const [h, m] = (t || "").split(":").map(Number);
  return h * 60 + (m || 0);
};

export type SaveSettings = {
  visitMinutes: number;
  dayStart: string; // "08:00"
  dayEnd: string; // "16:00"
  maxVisits: number;
  deadlineDays: number;
  startLabel: string;
  startLat: number;
  startLng: number;
};

export async function saveSettings(
  s: SaveSettings,
): Promise<{ ok: boolean; error?: string }> {
  const start = toMin(s.dayStart);
  const end = toMin(s.dayEnd);
  if (end <= start) return { ok: false, error: "De eindtijd moet na de begintijd liggen." };
  if (end - start < s.visitMinutes)
    return { ok: false, error: "De werkdag is korter dan één bezoek." };
  if (s.visitMinutes < 5 || s.visitMinutes > 240) return { ok: false, error: "Ongeldige bezoekduur." };
  if (s.maxVisits < 1 || s.maxVisits > 30) return { ok: false, error: "Max. bezoeken moet tussen 1 en 30 liggen." };
  if (s.deadlineDays < 1 || s.deadlineDays > 14) return { ok: false, error: "Ongeldig aantal invuldagen." };

  const supabase = await supabaseServer();
  const org = await adminOrgId(supabase);
  if (!org) return { ok: false, error: "Geen beheerder." };

  const { error } = await supabase
    .from("organizations")
    .update({
      visit_minutes: s.visitMinutes,
      day_start_local: s.dayStart,
      max_working_minutes: end - start,
      max_visits_per_day: s.maxVisits,
      deadline_days: s.deadlineDays,
      start_label: s.startLabel.trim(),
      start_lat: s.startLat,
      start_lng: s.startLng,
    })
    .eq("id", org);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/instellingen");
  return { ok: true };
}

// Startpunt opzoeken via PDOK (postcode + huisnummer -> adres + coördinaten).
export async function lookupStart(
  postcode: string,
  huisnummer: string,
): Promise<{ ok: boolean; label?: string; lat?: number; lng?: number; error?: string }> {
  const r = await lookupByPostcode(postcode, huisnummer);
  if (!r.ok) {
    return {
      ok: false,
      error: r.reason === "invalid" ? "Vul een geldige postcode en huisnummer in." : "Adres niet gevonden.",
    };
  }
  return {
    ok: true,
    label: `${r.straat} ${r.huisnummer}, ${r.postcode} ${r.plaats}`,
    lat: r.lat,
    lng: r.lng,
  };
}
