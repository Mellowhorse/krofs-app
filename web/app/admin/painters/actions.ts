"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabaseServer";
import { normalizeNLPhone } from "@/lib/phone";

export async function updatePainter(
  id: string,
  fullName: string,
  phone: string,
): Promise<{ ok: boolean; error?: string; phone?: string }> {
  if (!fullName.trim()) return { ok: false, error: "Vul een naam in." };
  const norm = normalizeNLPhone(phone);
  if (!norm.ok) return { ok: false, error: "Vul een geldig 06-nummer in." };

  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("painters")
    .update({ full_name: fullName.trim(), wa_phone_e164: norm.e164 })
    .eq("id", id);
  if (error) {
    if (/duplicate|unique/i.test(error.message)) {
      return { ok: false, error: "Dit 06-nummer hoort al bij een andere schilder." };
    }
    return { ok: false, error: error.message };
  }
  revalidatePath("/admin/painters");
  return { ok: true, phone: norm.e164 };
}

export async function setPainterActive(
  id: string,
  active: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await supabaseServer();
  const { error } = await supabase.from("painters").update({ is_active: active }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/painters");
  revalidatePath("/admin");
  return { ok: true };
}

// Voeg een (spook)schilder samen met een andere: reacties/route verhuizen mee,
// de bron wordt verwijderd. Handig als iemand met een typefout in z'n nummer
// een dubbele self-report heeft aangemaakt.
export async function mergePainters(
  sourceId: string,
  targetId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (sourceId === targetId) return { ok: false, error: "Kies twee verschillende schilders." };
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("merge_painter", {
    p_source: sourceId,
    p_target: targetId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/painters");
  revalidatePath("/admin");
  return { ok: true };
}

// Definitief verwijderen. Lukt niet als de schilder al in een gebouwde route
// zit — dan is archiveren de juiste keuze.
export async function deletePainter(id: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await supabaseServer();
  const { error: invErr } = await supabase.from("round_invites").delete().eq("painter_id", id);
  if (invErr) {
    return {
      ok: false,
      error: "Deze schilder zit al in een gebouwde route. Archiveer 'm in plaats van verwijderen.",
    };
  }
  const { error } = await supabase.from("painters").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/painters");
  revalidatePath("/admin");
  return { ok: true };
}
