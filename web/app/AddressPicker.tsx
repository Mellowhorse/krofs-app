"use client";

import { useEffect, useState, type MutableRefObject } from "react";
import { lookupAddressAction } from "@/app/address-actions";

export type Address = {
  postcode: string;
  huisnummer: string;
  straat: string;
  plaats: string;
};

type LookState = "idle" | "searching" | "found" | "notfound" | "invalid";

// Postcode + huisnummer -> verified address (PDOK), with a "klopt niet?" escape
// to manual straat/plaats. The parent owns the Address value; `resolveRef` lets
// the parent trigger a lookup on submit (so pressing "Zoek adres" is optional).
export default function AddressPicker({
  value,
  onChange,
  resolveRef,
  initialManual = false,
}: {
  value: Address;
  onChange: (a: Address) => void;
  resolveRef?: MutableRefObject<(() => Promise<boolean>) | null>;
  initialManual?: boolean;
}) {
  const [look, setLook] = useState<LookState>(initialManual ? "found" : "idle");
  const [manual, setManual] = useState(initialManual);

  function setField(k: keyof Address, v: string) {
    onChange({ ...value, [k]: v });
    if ((k === "postcode" || k === "huisnummer") && look === "found") {
      setLook("idle");
      setManual(false);
    }
  }

  async function doLookup(): Promise<boolean> {
    if (!value.postcode.trim() || !value.huisnummer.trim()) {
      setLook("invalid");
      return false;
    }
    setLook("searching");
    const res = await lookupAddressAction(value.postcode, value.huisnummer);
    if (res.ok) {
      onChange({
        postcode: res.postcode,
        huisnummer: res.huisnummer,
        straat: res.straat,
        plaats: res.plaats,
      });
      setManual(false);
      setLook("found");
      return true;
    }
    if (res.reason === "invalid") {
      setLook("invalid");
      return false;
    }
    setManual(true); // not_found / error -> manual straat + plaats
    setLook("notfound");
    return false;
  }

  async function ensureResolved(): Promise<boolean> {
    if (manual || look === "found") {
      return !!(value.straat.trim() && value.plaats.trim());
    }
    return doLookup();
  }
  // Expose the resolver to the parent (updated every render to close over latest state).
  useEffect(() => {
    if (resolveRef) resolveRef.current = ensureResolved;
  });

  return (
    <>
      <div className="grid2 mb10">
        <div>
          <p className="flabel">Postcode</p>
          <input
            type="text"
            value={value.postcode}
            onChange={(e) => setField("postcode", e.target.value)}
            placeholder="1234 AB"
            autoComplete="postal-code"
          />
        </div>
        <div>
          <p className="flabel">Huisnr.</p>
          <input
            type="text"
            value={value.huisnummer}
            onChange={(e) => setField("huisnummer", e.target.value)}
            inputMode="numeric"
            autoComplete="off"
          />
        </div>
      </div>

      {look !== "found" && !manual ? (
        <button
          type="button"
          className="btn btn-ghost addr-lookup"
          onClick={doLookup}
          disabled={look === "searching"}
        >
          {look === "searching" ? "Zoeken…" : "Zoek adres"}
        </button>
      ) : null}

      {look === "invalid" ? (
        <p className="err">Vul een geldige postcode (1234 AB) en huisnummer in.</p>
      ) : null}

      {look === "found" && !manual ? (
        <div className="addr-ok">
          <span>
            &#10003; {value.straat} {value.huisnummer}, {value.postcode} {value.plaats}
          </span>
          <button type="button" className="linkbtn" onClick={() => setManual(true)}>
            klopt niet?
          </button>
        </div>
      ) : null}

      {manual ? (
        <div className="mb10">
          {look === "notfound" ? (
            <p className="muted" style={{ fontSize: 13, margin: "0 0 8px" }}>
              Adres niet automatisch gevonden — vul straat en plaats even zelf in.
            </p>
          ) : null}
          <p className="flabel">Straat</p>
          <input
            type="text"
            className="mb10"
            value={value.straat}
            onChange={(e) => setField("straat", e.target.value)}
            autoComplete="off"
          />
          <p className="flabel">Plaats</p>
          <input
            type="text"
            value={value.plaats}
            onChange={(e) => setField("plaats", e.target.value)}
            autoComplete="off"
          />
          <button
            type="button"
            className="linkbtn"
            style={{ marginTop: 8 }}
            onClick={() => {
              setManual(false);
              setLook("idle");
            }}
          >
            adres opnieuw opzoeken
          </button>
        </div>
      ) : null}
    </>
  );
}
