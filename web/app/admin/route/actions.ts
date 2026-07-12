"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabaseServer";
import { buildRoute } from "@/lib/route";

// Build (or rebuild) the driving plan for a round. Uses the service_role
// builder; the whole thing is atomic via start/finalize/fail RPCs.
export async function buildRouteAction(
  roundId: string,
): Promise<{ ok: boolean; summary?: string; error?: string }> {
  const r = await buildRoute(roundId);
  revalidatePath("/admin/route");
  revalidatePath("/admin");
  if (!r.ok) return { ok: false, error: r.error };
  const parts = [
    `${r.days} dag${r.days === 1 ? "" : "en"}`,
    `${r.stops} adres${r.stops === 1 ? "" : "sen"}`,
    `${r.painters} schilder${r.painters === 1 ? "" : "s"}`,
  ];
  if (r.unrouted) parts.push(`${r.unrouted} niet te plaatsen`);
  return { ok: true, summary: `${parts.join(" · ")} (${r.provider})` };
}

// "Gezien" tap: toggle a stop's visited_at. Runs as the authenticated admin
// (RLS-scoped), not service_role.
export async function markVisited(
  stopId: string,
  visited: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("route_stops")
    .update({ visited_at: visited ? new Date().toISOString() : null })
    .eq("id", stopId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/route");
  return { ok: true };
}
