"use server";

import { lookupByPostcode, type AddressLookup } from "@/lib/geocode";

// Shared by both intake forms (/u self-identify and /r per-token): postcode +
// huisnummer -> a verified, complete address via PDOK. Keeps the two forms
// identical so they can't drift.
export async function lookupAddressAction(
  postcode: string,
  huisnummer: string,
): Promise<AddressLookup> {
  return lookupByPostcode(postcode, huisnummer);
}
