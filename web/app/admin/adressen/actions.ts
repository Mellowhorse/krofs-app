"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabaseServer";
import { geocodeResponses } from "@/lib/sweeps";

export async function retryAddress(
  id: string,
  addr: { straat: string; huisnummer: string; postcode: string; plaats: string },
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("invite_responses")
    .update({
      straat: addr.straat.trim(),
      huisnummer: addr.huisnummer.trim(),
      postcode: addr.postcode.trim() || null,
      plaats: addr.plaats.trim(),
      geocode_status: "pending",
      geocode_attempts: 0,
      geocode_leased_until: null,
      lat: null,
      lng: null,
      manual_override: false,
      admin_corrected_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  // Geocode immediately so the admin sees the result (service_role sweep).
  await geocodeResponses(20);
  revalidatePath("/admin/adressen");
  return { ok: true };
}

export async function acceptAddress(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("invite_responses")
    .update({ manual_override: true, admin_corrected_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/adressen");
  return { ok: true };
}

export async function geocodeNow(): Promise<{ ok: boolean; summary?: string }> {
  const g = await geocodeResponses(50);
  revalidatePath("/admin/adressen");
  return {
    ok: true,
    summary: `${g.claimed} verwerkt · ${g.ok} gevonden · ${g.review} controleren · ${g.retry} opnieuw (${g.provider})`,
  };
}
