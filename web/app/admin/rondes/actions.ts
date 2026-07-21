"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabaseServer";
import { runTick } from "@/lib/sweeps";

export type SendLink = { name: string; phone: string; url: string; waLink: string };

type RegenRow = {
  invite_id: string;
  painter_id: string;
  full_name: string;
  wa_phone_e164: string;
  raw_token: string;
};

// Kees kiest de bezoekweek (een maandag) en de dagen waarop hij zelf langs kan.
// De DB bewaakt beide (db/012); de naam volgt uit de bezoekweek (db/011).
export async function startRonde(
  visitWeekStart: string,
  visitDays: number[],
): Promise<{ ok: boolean; count?: number; error?: string }> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("start_weekronde", {
    p_visit_week_start: visitWeekStart,
    p_visit_days: visitDays,
    p_painter_ids: null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/rondes");
  revalidatePath("/admin");
  return { ok: true, count: (data as number) ?? 0 };
}

// Automated dispatch (the outbox sweep) — same code the cron runs; usable
// on-demand for the pilot. In SEND_MODE=sandbox this is a dry-run.
export async function dispatchNow(): Promise<{
  ok: boolean;
  summary?: string;
  error?: string;
}> {
  try {
    const r = await runTick();
    const s = `verstuurd ${r.invites.sent}, herinneringen ${r.reminders.sent}, geblokkeerd ${r.invites.blocked + r.reminders.blocked}, mislukt ${r.invites.failed + r.reminders.failed} (modus: ${r.invites.mode})`;
    revalidatePath("/admin/rondes");
    return { ok: true, summary: s };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "onbekende fout" };
  }
}

// Manual fallback: mint fresh links for not-yet-responded invites (wa.me).
export async function regenerateLinks(
  roundId: string,
): Promise<{ ok: boolean; links?: SendLink[]; error?: string }> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("regenerate_invite_tokens", {
    p_round_id: roundId,
  });
  if (error) return { ok: false, error: error.message };
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3100";
  const links = ((data ?? []) as RegenRow[]).map((r) => {
    const first = r.full_name.split(" ")[0];
    const url = `${base}/r/${r.raw_token}`;
    const msg = `Hoi ${first}, Kees (Krofs) komt binnenkort langs. Geef even door waar je werkt en op welke dagen: ${url}`;
    return {
      name: r.full_name,
      phone: r.wa_phone_e164,
      url,
      waLink: `https://wa.me/${r.wa_phone_e164.replace(/^\+/, "")}?text=${encodeURIComponent(msg)}`,
    };
  });
  return { ok: true, links };
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
