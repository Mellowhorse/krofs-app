import "server-only";
import { admin } from "./supabaseAdmin";
import { newSender, sendInvite } from "./whatsapp";
import { geocodeAddress, distanceKm, hasGoogleKey } from "./geocode";

const BASE = process.env.PUBLIC_BASE_URL || "http://localhost:3100";
const FAR_KM = Number(process.env.GEOCODE_REVIEW_KM ?? "75");

type ClaimRow = {
  raw_token: string;
  to_phone: string;
  full_name: string;
  org_id: string;
  message_id: string;
};

function toIds(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.map((x) =>
    typeof x === "string" ? x : (Object.values(x as object)[0] as string),
  );
}

async function dispatchKind(
  kind: "invite" | "reminder",
  idFn: "pending_invite_ids" | "due_reminder_ids",
) {
  const guard = newSender();
  const { data: rawIds } = await admin.rpc(idFn, { p_limit: 200 });
  const ids = toIds(rawIds);

  let sent = 0;
  let blocked = 0;
  let failed = 0;

  for (const id of ids) {
    const { data: claim } = await admin.rpc("claim_invite_for_send", {
      p_invite_id: id,
      p_kind: kind,
    });
    const row = ((claim ?? []) as ClaimRow[])[0];
    if (!row) continue; // already sent / skipped

    const link = `${BASE}/r/${row.raw_token}`;
    const res = await sendInvite(guard, {
      to: row.to_phone,
      firstName: row.full_name.split(" ")[0],
      link,
      kind,
    });

    if (res.ok) {
      await admin
        .from("message_log")
        .update({
          status: "sent",
          provider_message_id: res.providerId,
          provider: res.simulated ? "sandbox" : "meta",
        })
        .eq("id", row.message_id);
      sent++;
    } else {
      await admin
        .from("message_log")
        .update({ status: "failed", error_code: res.error.slice(0, 100) })
        .eq("id", row.message_id);
      if (res.blocked) blocked++;
      else failed++;
    }
  }
  return { mode: guard.mode, candidates: ids.length, sent, blocked, failed };
}

export function dispatchInvites() {
  return dispatchKind("invite", "pending_invite_ids");
}
export function sendReminders() {
  return dispatchKind("reminder", "due_reminder_ids");
}
export async function closeDueRounds() {
  const { data } = await admin.rpc("close_due_rounds");
  return { closed: (data as number) ?? 0 };
}

type GeoAddr = {
  id: string;
  straat: string;
  huisnummer: string;
  postcode: string | null;
  plaats: string;
};

export async function geocodeResponses(limit = 20) {
  const { data } = await admin.rpc("claim_geocode_batch", {
    p_limit: limit,
    p_lease_seconds: 120,
  });
  const rows = (data ?? []) as GeoAddr[];
  const provider = hasGoogleKey() ? "google" : "stub";
  let ok = 0;
  let review = 0;
  let retry = 0;

  for (const r of rows) {
    const g = await geocodeAddress(r);

    if (g.status === "ok") {
      const km = distanceKm(g.lat, g.lng);
      const far = km > FAR_KM;
      await admin
        .from("invite_responses")
        .update({
          geocode_status: far ? "ambiguous" : "ok",
          lat: g.lat,
          lng: g.lng,
          geocode_place_id: g.placeId ?? null,
          geocode_confidence: g.confidence ?? null,
          geocode_provider: provider,
          geocoded_at: new Date().toISOString(),
          geocode_leased_until: null,
          geocode_error: far ? `ver van startpunt (${Math.round(km)} km)` : null,
        })
        .eq("id", r.id);
      far ? review++ : ok++;
    } else if (g.status === "error") {
      // transient — clear the lease so the next sweep retries (attempts bumped)
      await admin
        .from("invite_responses")
        .update({ geocode_status: "error", geocode_leased_until: null, geocode_error: (g.error ?? "").slice(0, 200) })
        .eq("id", r.id);
      retry++;
    } else {
      // not_found / ambiguous — terminal, goes to the fix queue
      await admin
        .from("invite_responses")
        .update({
          geocode_status: g.status,
          lat: g.lat ?? null,
          lng: g.lng ?? null,
          geocode_leased_until: null,
          geocode_error: (g.error ?? "").slice(0, 200) || null,
        })
        .eq("id", r.id);
      review++;
    }
  }
  return { provider, claimed: rows.length, ok, review, retry };
}

export async function runTick() {
  const invites = await dispatchInvites();
  const reminders = await sendReminders();
  const geocode = await geocodeResponses();
  const closed = await closeDueRounds();
  return { invites, reminders, geocode, ...closed };
}
