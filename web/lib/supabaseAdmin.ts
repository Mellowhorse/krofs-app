import "server-only";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (set them in web/.env.local)",
  );
}

// Server-only admin client. The service_role key must NEVER reach the browser;
// `import "server-only"` makes a client import of this module a build error.
export const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export type InviteView = {
  ok: true;
  painter_name: string;
  round_label: string | null;
  visit_week_start: string; // yyyy-mm-dd
  visit_week_end: string;
  visit_weekdays: number[]; // isodow 1=ma..5=vr waarop de beheerder langskomt
  deadline_at: string;
  prefill: {
    straat: string;
    huisnummer: string;
    postcode: string | null;
    plaats: string;
  } | null;
};

export type RpcFail = { ok: false; reason?: string };

export async function getInviteByToken(
  token: string,
): Promise<InviteView | RpcFail> {
  const { data, error } = await admin.rpc("get_invite_by_token", {
    p_token: token,
  });
  if (error) {
    console.error("[get_invite_by_token]", error.message);
    return { ok: false };
  }
  return data as InviteView | RpcFail;
}

export type SubmitArgs = {
  token: string;
  straat?: string;
  huisnummer?: string;
  postcode?: string;
  plaats?: string;
  workdays?: string[]; // yyyy-mm-dd
  noWork?: boolean;
};

export async function submitResponse(
  args: SubmitArgs,
): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await admin.rpc("submit_response", {
    p_token: args.token,
    p_straat: args.straat ?? null,
    p_huisnummer: args.huisnummer ?? null,
    p_postcode: args.postcode ?? null,
    p_plaats: args.plaats ?? null,
    p_workdays: args.workdays ?? null,
    p_no_work: args.noWork ?? false,
  });
  if (error) {
    console.error("[submit_response]", error.message);
    return { ok: false, reason: "server_error" };
  }
  return data as { ok: boolean; reason?: string };
}

// ---- Option 2: shared broadcast intake (self-identify by phone) ------------

export type RoundView = {
  ok: true;
  round_label: string | null;
  visit_week_start: string; // yyyy-mm-dd
  visit_week_end: string;
  visit_weekdays: number[]; // isodow 1=ma..5=vr waarop de beheerder langskomt
  deadline_at: string;
};

export async function getRoundBySlug(
  slug: string,
): Promise<RoundView | RpcFail> {
  const { data, error } = await admin.rpc("get_round_by_slug", { p_slug: slug });
  if (error) {
    console.error("[get_round_by_slug]", error.message);
    return { ok: false };
  }
  return data as RoundView | RpcFail;
}

export type PublicSubmitArgs = {
  slug: string;
  name: string;
  phoneE164: string;
  straat?: string;
  huisnummer?: string;
  postcode?: string;
  plaats?: string;
  workdays?: string[]; // yyyy-mm-dd
  noWork?: boolean;
};

export async function submitPublicResponse(
  args: PublicSubmitArgs,
): Promise<{ ok: boolean; reason?: string; matched?: boolean }> {
  const { data, error } = await admin.rpc("submit_public_response", {
    p_slug: args.slug,
    p_name: args.name,
    p_phone_e164: args.phoneE164,
    p_straat: args.straat ?? null,
    p_huisnummer: args.huisnummer ?? null,
    p_postcode: args.postcode ?? null,
    p_plaats: args.plaats ?? null,
    p_workdays: args.workdays ?? null,
    p_no_work: args.noWork ?? false,
  });
  if (error) {
    console.error("[submit_public_response]", error.message);
    return { ok: false, reason: "server_error" };
  }
  return data as { ok: boolean; reason?: string; matched?: boolean };
}
