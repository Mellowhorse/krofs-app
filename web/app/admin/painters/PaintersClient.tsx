"use client";

import { useState, useTransition } from "react";
import { updatePainter, setPainterActive, deletePainter, mergePainters } from "./actions";

export type PainterRow = {
  id: string;
  name: string;
  phone: string;
  active: boolean;
  selfReport: boolean;
};

function Row({ row, others }: { row: PainterRow; others: PainterRow[] }) {
  const [name, setName] = useState(row.name);
  const [phone, setPhone] = useState(row.phone);
  const [active, setActive] = useState(row.active);
  const [gone, setGone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [merging, setMerging] = useState(false);
  const [target, setTarget] = useState("");
  const [pending, start] = useTransition();

  const dirty = name !== row.name || phone !== row.phone;

  function save() {
    setErr(null);
    start(async () => {
      const res = await updatePainter(row.id, name, phone);
      if (!res.ok) setErr(res.error ?? "Opslaan mislukt.");
      else {
        if (res.phone) setPhone(res.phone);
        row.name = name;
        row.phone = res.phone ?? phone;
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }
    });
  }
  function toggleActive() {
    setErr(null);
    const next = !active;
    setActive(next);
    start(async () => {
      const res = await setPainterActive(row.id, next);
      if (!res.ok) {
        setActive(!next);
        setErr(res.error ?? "Mislukt.");
      }
    });
  }
  function remove() {
    setErr(null);
    if (!window.confirm(`"${row.name}" definitief verwijderen?\n\nDit kan niet ongedaan worden gemaakt.`))
      return;
    start(async () => {
      const res = await deletePainter(row.id);
      if (!res.ok) setErr(res.error ?? "Verwijderen mislukt.");
      else setGone(true);
    });
  }
  function doMerge() {
    setErr(null);
    const t = others.find((o) => o.id === target);
    if (!t) return setErr("Kies een schilder om mee samen te voegen.");
    if (
      !window.confirm(
        `"${row.name}" samenvoegen met "${t.name}"?\n\nDe reacties van "${row.name}" gaan naar "${t.name}" en "${row.name}" verdwijnt. Dit kan niet ongedaan worden gemaakt.`,
      )
    )
      return;
    start(async () => {
      const res = await mergePainters(row.id, target);
      if (!res.ok) setErr(res.error ?? "Samenvoegen mislukt.");
      else setGone(true);
    });
  }

  if (gone) return null;

  return (
    <div className={`painterrow${active ? "" : " painter-archived"}`}>
      <div className="painterrow-fields">
        <input
          className="painter-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Naam"
        />
        <input
          className="painter-phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
          aria-label="06-nummer"
        />
        {row.selfReport ? <span className="pill pill-dup_db">zelf aangemeld</span> : null}
        {!active ? <span className="pill pill-dup_db">gearchiveerd</span> : null}
      </div>
      <div className="painterrow-actions">
        {dirty ? (
          <button className="btn-sm btn-wa" onClick={save} disabled={pending}>
            Opslaan
          </button>
        ) : saved ? (
          <span className="muted" style={{ fontSize: 13 }}>Opgeslagen</span>
        ) : null}
        <button className="btn-sm" onClick={toggleActive} disabled={pending}>
          {active ? "Archiveer" : "Activeer"}
        </button>
        {others.length ? (
          <button className="btn-sm" onClick={() => setMerging((m) => !m)} disabled={pending}>
            Samenvoegen
          </button>
        ) : null}
        <button className="btn-sm linkbtn-danger" onClick={remove} disabled={pending}>
          Verwijder
        </button>
      </div>

      {merging ? (
        <div className="merge-panel">
          <span className="muted" style={{ fontSize: 13 }}>Voeg samen met:</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="merge-select">
            <option value="">— kies schilder —</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} {o.phone ? `(${o.phone})` : ""}
              </option>
            ))}
          </select>
          <button className="btn-sm btn-wa" onClick={doMerge} disabled={pending || !target}>
            Voeg samen
          </button>
          <button className="btn-sm" onClick={() => setMerging(false)} disabled={pending}>
            Annuleer
          </button>
        </div>
      ) : null}

      {err ? <p className="err" style={{ width: "100%", margin: "6px 0 0" }}>{err}</p> : null}
    </div>
  );
}

export default function PaintersClient({ painters }: { painters: PainterRow[] }) {
  if (painters.length === 0) {
    return (
      <div className="roundcard">
        <p className="intro">
          Nog geen schilders. Voeg ze toe via <b>Schilders importeren</b>.
        </p>
      </div>
    );
  }
  return (
    <div className="painterlist">
      {painters.map((p) => (
        <Row key={p.id} row={p} others={painters.filter((o) => o.id !== p.id)} />
      ))}
    </div>
  );
}
