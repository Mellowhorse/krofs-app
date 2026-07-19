"use server";

import { normalizeNLPhone } from "@/lib/phone";
import { lookupByPostcode, type AddressLookup } from "@/lib/geocode";
import { submitPublicResponse, type PublicSubmitArgs } from "@/lib/supabaseAdmin";

// Postcode + huisnummer -> verified address (PDOK). Used by the form to autofill
// straat/plaats so the schilder can never submit an incomplete/wrong address.
export async function lookupAddressAction(
  postcode: string,
  huisnummer: string,
): Promise<AddressLookup> {
  return lookupByPostcode(postcode, huisnummer);
}

export type PublicFormArgs = {
  slug: string;
  name: string;
  phone: string;
  straat?: string;
  huisnummer?: string;
  postcode?: string;
  plaats?: string;
  workdays?: string[];
  noWork?: boolean;
};

export async function submitPublicAction(
  args: PublicFormArgs,
): Promise<{ ok: boolean; reason?: string }> {
  // Name + phone are the identity here (there is no per-painter token). Phone is
  // normalized to E.164 on the server so it reliably matches the roster; the RPC
  // re-checks the format too (fail-closed).
  if (!args.name?.trim()) return { ok: false, reason: "name_required" };
  const phone = normalizeNLPhone(args.phone ?? "");
  if (!phone.ok) return { ok: false, reason: "phone_invalid" };

  const payload: PublicSubmitArgs = {
    slug: args.slug,
    name: args.name.trim(),
    phoneE164: phone.e164,
    straat: args.straat,
    huisnummer: args.huisnummer,
    postcode: args.postcode,
    plaats: args.plaats,
    workdays: args.workdays,
    noWork: args.noWork ?? false,
  };
  return submitPublicResponse(payload);
}
