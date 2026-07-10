"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  previewImport,
  commitImport,
  type PreviewRow,
} from "./actions";

const STATUS_LABEL: Record<PreviewRow["status"], string> = {
  ok: "toevoegen",
  invalid: "ongeldig",
  dup_csv: "dubbel",
  dup_db: "bestaat al",
};

export default function ImportPage() {
  const [csv, setCsv] = useState("");
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [okCount, setOkCount] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function doPreview() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await previewImport(csv);
      if (!res.ok) {
        setError(res.error ?? "Er ging iets mis.");
        return;
      }
      setRows(res.rows);
      setOkCount(res.okCount);
    });
  }

  function doCommit() {
    setError(null);
    startTransition(async () => {
      const res = await commitImport(csv);
      if (!res.ok) {
        setError(res.error ?? "Importeren mislukt.");
        return;
      }
      setResult(`${res.inserted} schilder${res.inserted === 1 ? "" : "s"} toegevoegd.`);
      setRows(null);
      setCsv("");
    });
  }

  return (
    <div>
      <p className="crumb">
        <Link href="/admin">Beheer</Link> / Schilders importeren
      </p>
      <h1>Schilders importeren</h1>
      <p className="intro">
        Plak per regel: <code>naam, telefoon</code> (komma, puntkomma of tab).
        Nummers als 06…, 0031… of +31… worden automatisch genormaliseerd.
      </p>

      {result ? (
        <div className="banner ok">{result}</div>
      ) : null}
      {error ? <div className="banner err">{error}</div> : null}

      <textarea
        className="csv"
        rows={8}
        placeholder={"Jan Jansen, 0612345678\nPiet de Boer; +31611112222"}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
      />

      <div className="row-actions">
        <button
          className="btn btn-primary"
          style={{ width: "auto", padding: "10px 18px" }}
          disabled={pending || csv.trim().length === 0}
          onClick={doPreview}
        >
          {pending ? "Bezig…" : "Controleer"}
        </button>
      </div>

      {rows ? (
        <div className="preview">
          <table className="ptable">
            <thead>
              <tr>
                <th>#</th>
                <th>Naam</th>
                <th>Nummer</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.line} className={`st-${r.status}`}>
                  <td>{r.line}</td>
                  <td>{r.naam || <span className="muted">—</span>}</td>
                  <td>{r.e164 ?? r.ruw}</td>
                  <td>
                    <span className={`pill pill-${r.status}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                    {r.reason ? <span className="muted"> · {r.reason}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row-actions">
            <button
              className="btn btn-primary"
              style={{ width: "auto", padding: "10px 18px" }}
              disabled={pending || okCount === 0}
              onClick={doCommit}
            >
              {pending
                ? "Bezig…"
                : `Importeer ${okCount} schilder${okCount === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
