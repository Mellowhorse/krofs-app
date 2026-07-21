"use server";

import { revalidatePath } from "next/cache";
import { geocodeResponses } from "@/lib/sweeps";

// Handmatig de adres-opzoeker draaien. De cron doet dit ook, maar GitHub Actions
// kan een kwartierslot overslaan of vertragen — hiermee hoeft Kees daar nooit op
// te wachten.
export async function geocodeNowAction(): Promise<{ ok: number; review: number }> {
  const g = await geocodeResponses(50);
  revalidatePath("/admin/reacties");
  revalidatePath("/admin/adressen");
  return { ok: g.ok, review: g.review };
}
