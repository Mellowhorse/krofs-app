// NL phone -> E.164 normalization for the painter CSV importer.
// Must end up matching the DB CHECK on painters.wa_phone_e164:
//   ^\+[1-9][0-9]{7,14}$
// Rules: strip spaces/dashes/dots/parens; 0031 -> +31; leading 0 -> +31;
// bare 31... -> +31...; keep an existing +.. as-is. Reject anything else.

export type PhoneResult =
  | { ok: true; e164: string }
  | { ok: false; reason: string };

export function normalizeNLPhone(raw: string): PhoneResult {
  if (raw == null) return { ok: false, reason: "leeg" };
  let s = String(raw).trim().replace(/[\s\-().]/g, "");
  if (s === "") return { ok: false, reason: "leeg" };

  if (s.startsWith("00")) {
    s = "+" + s.slice(2); // 0031... -> +31...
  } else if (s.startsWith("+")) {
    // keep
  } else if (s.startsWith("0")) {
    s = "+31" + s.slice(1); // 06... -> +316...
  } else if (/^31\d+$/.test(s)) {
    s = "+" + s; // 316... -> +316...
  } else {
    return { ok: false, reason: "onbekend formaat" };
  }

  if (!/^\+[1-9][0-9]{7,14}$/.test(s)) {
    return { ok: false, reason: "ongeldig nummer" };
  }
  // NL sanity: a +31 number should be 11 digits total (+31 + 9), catches typos.
  if (s.startsWith("+31") && s.length !== 12) {
    return { ok: false, reason: "NL-nummer moet 9 cijfers na +31 hebben" };
  }
  return { ok: true, e164: s };
}
