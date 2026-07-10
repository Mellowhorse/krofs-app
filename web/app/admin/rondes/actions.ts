"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabaseServer";

export type SendLink = {
  name: string;
  phone: string;
  url: string;
  waLink: string;
};

type RpcRow = {
  invite_id: string;
  painter_id: string;
  full_name: string;
  wa_phone_e164: string;
  raw_token: string;
};

function buildLinks(rows: RpcRow[]): SendLink[] {
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3100";
  return rows.map((r) => {
    const first = r.full_name.split(" ")[0];
    const url = `${base}/r/${r.raw_token}`;
    const msg = `Hoi ${first}, Ruben (Krofs) komt binnenkort langs voor een kop koffie. Geef even door waar je werkt en op welke dagen: ${url}`;
    const waLink = `https://wa.me/${r.wa_phone_e164.replace(/^\+/, "")}?text=${encodeURIComponent(msg)}`;
    return { name: r.full_name, phone: r.wa_phone_e164, url, waLink };
  });
}

export async function startRonde(
  label: string,
): Promise<{ ok: boolean; links?: SendLink[]; error?: string }> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("start_weekronde", {
    p_label: label || null,
    p_painter_ids: null,
  });
  if (error) return { ok: false, error: error.message };
  if (!data || (data as RpcRow[]).length === 0) {
    return { ok: false, error: "Geen actieve schilders met opt-in om uit te nodigen." };
  }
  revalidatePath("/admin/rondes");
  revalidatePath("/admin");
  return { ok: true, links: buildLinks(data as RpcRow[]) };
}

export async function regenerateLinks(
  roundId: string,
): Promise<{ ok: boolean; links?: SendLink[]; error?: string }> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("regenerate_invite_tokens", {
    p_round_id: roundId,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, links: buildLinks((data ?? []) as RpcRow[]) };
}

export async function closeRonde(
  roundId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("weekrondes")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("id", roundId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/rondes");
  revalidatePath("/admin");
  return { ok: true };
}
