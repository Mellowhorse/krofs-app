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

// Throw on a Supabase error so a broken sweep surfaces instead of silently
// reporting success. Callers run inside runTick's per-phase try/catch.
function orThrow<T>(res: { data: T; error: { message: string } | null }, ctx: string): T {
  if (res.error) throw new Error(`${ctx}: ${res.error.message}`);
  return res.data;
}

async function dispatchKind(
  kind: "invite" | "reminder",
  idFn: "pending_invite_ids" | "due_reminder_ids",
) {
  const guard = newSender();
  const rawIds = orThrow(await admin.rpc(idFn, { p_limit: 200 }), idFn);
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

    try {

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
    } catch (e) {
      // one bad send must not abort the whole batch
      await admin
        .from("message_log")
        .update({ status: "failed", error_code: (e instanceof Error ? e.message : "fout").slice(0, 100) })
        .eq("id", row.message_id);
      failed++;
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
  const data = orThrow(await admin.rpc("close_due_rounds"), "close_due_rounds");
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
  const data = orThrow(
    await admin.rpc("claim_geocode_batch", { p_limit: limit, p_lease_seconds: 120 }),
    "claim_geocode_batch",
  );
  const rows = (data ?? []) as GeoAddr[];
  const provider =
    process.env.GEOCODE_PROVIDER === "stub" ? "stub" : hasGoogleKey() ? "google" : "pdok";
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

// Each phase runs isolated: a failure in one (e.g. a geocoding outage) is
// recorded in `errors` but must not stop the others — closing due rounds always
// runs. A non-empty `errors` lets /api/tick answer 500 so the scheduler alerts.
export async function runTick() {
  const errors: string[] = [];
  async function phase<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  }

  const invites = await phase("invites", dispatchInvites, {
    mode: "error", candidates: 0, sent: 0, blocked: 0, failed: 0,
  });
  const reminders = await phase("reminders", sendReminders, {
    mode: "error", candidates: 0, sent: 0, blocked: 0, failed: 0,
  });
  const geocode = await phase("geocode", () => geocodeResponses(), {
    provider: "error", claimed: 0, ok: 0, review: 0, retry: 0,
  });
  const closed = await phase("close", closeDueRounds, { closed: 0 });

  return { invites, reminders, geocode, ...closed, errors };
}
