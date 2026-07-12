"use client";

import { useState, useTransition } from "react";
import { retryAddress, acceptAddress, geocodeNow } from "./actions";

export type QueueRow = {
  id: string;
  name: string;
  straat: string;
  huisnummer: string;
  postcode: string | null;
  plaats: string;
  status: string;
  error: string | null;
  attempts: number;
  hasCoords: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  not_found: "niet gevonden",
  ambiguous: "controleren",
  error: "mislukt",
};

function Row({ row }: { row: QueueRow }) {
  const [straat, setStraat] = useState(row.straat);
  const [huisnummer, setHuisnummer] = useState(row.huisnummer);
  const [postcode, setPostcode] = useState(row.postcode ?? "");
  const [plaats, setPlaats] = useState(row.plaats);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="fixrow">
      <div className="fixrow-head">
        <span className="linkrow-name">{row.name}</span>
        <span className={`pill pill-${row.status === "not_found" || row.status === "error" ? "invalid" : "dup_db"}`}>
          {STATUS_LABEL[row.status] ?? row.status}
        </span>
        {row.error ? <span className="muted"> · {row.error}</span> : null}
      </div>
      <div className="grid2 mb10" style={{ marginTop: 8 }}>
        <div>
          <p className="flabel">Straat</p>
          <input type="text" value={straat} onChange={(e) => setStraat(e.target.value)} />
        </div>
        <div>
          <p className="flabel">Huisnr.</p>
          <input type="text" value={huisnummer} onChange={(e) => setHuisnummer(e.target.value)} />
        </div>
      </div>
      <div className="grid2 mb10">
        <div>
          <p className="flabel">Postcode</p>
          <input type="text" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
        </div>
        <div>
          <p className="flabel">Plaats</p>
          <input type="text" value={plaats} onChange={(e) => setPlaats(e.target.value)} />
        </div>
      </div>
      {err ? <p className="err">{err}</p> : null}
      <div className="linkrow-actions">
        <button
          className="btn-sm"
          disabled={pending}
          onClick={() => {
            setErr(null);
            start(async () => {
              const r = await retryAddress(row.id, { straat, huisnummer, postcode, plaats });
              if (!r.ok) setErr(r.error ?? "Mislukt.");
            });
          }}
        >
          {pending ? "Bezig…" : "Opnieuw proberen"}
        </button>
        {row.hasCoords ? (
          <button
            className="btn-sm"
            disabled={pending}
            onClick={() => {
              setErr(null);
              start(async () => {
                const r = await acceptAddress(row.id);
                if (!r.ok) setErr(r.error ?? "Mislukt.");
              });
            }}
          >
            Toch gebruiken
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function AdressenClient({ rows }: { rows: QueueRow[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div>
      <div className="row-actions">
        <button
          className="btn btn-primary"
          style={{ width: "auto", padding: "9px 16px" }}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await geocodeNow();
              setMsg(r.summary ?? "Klaar.");
            })
          }
        >
          {pending ? "Bezig…" : "Geocodeer nu"}
        </button>
      </div>
      {msg ? <div className="banner ok">{msg}</div> : null}

      {rows.length === 0 ? (
        <div className="roundcard">
          <p className="intro">Geen adressen om te controleren. Alles is netjes gevonden.</p>
        </div>
      ) : (
        rows.map((r) => <Row key={r.id} row={r} />)
      )}
    </div>
  );
}
