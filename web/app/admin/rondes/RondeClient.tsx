"use client";

import { useState, useTransition } from "react";
import {
  startRonde,
  dispatchNow,
  regenerateLinks,
  closeRonde,
  type SendLink,
} from "./actions";

export type ActiveRound = {
  id: string;
  label: string | null;
  deadline_at: string | null;
  visit_week_start: string | null;
  visit_week_end: string | null;
  invitesTotal: number;
  pendingCount: number;
  respondedCount: number;
};

function fmt(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
}

function LinkList({ links }: { links: SendLink[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="links">
      <p className="intro">
        {links.length} handmatige link{links.length === 1 ? "" : "s"}. Tik
        &ldquo;WhatsApp&rdquo; om het bericht te openen, of kopieer de link.
      </p>
      {links.map((l) => (
        <div className="linkrow" key={l.url}>
          <div className="linkrow-main">
            <div className="linkrow-name">{l.name}</div>
            <div className="linkrow-phone muted">{l.phone}</div>
          </div>
          <div className="linkrow-actions">
            <a className="btn-sm btn-wa" href={l.waLink} target="_blank" rel="noreferrer">
              WhatsApp
            </a>
            <button
              className="btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(l.url);
                setCopied(l.url);
                setTimeout(() => setCopied((c) => (c === l.url ? null : c)), 1500);
              }}
            >
              {copied === l.url ? "Gekopieerd" : "Kopieer link"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RondeClient({ active }: { active: ActiveRound | null }) {
  const [label, setLabel] = useState("");
  const [links, setLinks] = useState<SendLink[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function doStart() {
    setError(null);
    setMsg(null);
    start(async () => {
      const res = await startRonde(label);
      if (!res.ok) setError(res.error ?? "Starten mislukt.");
      else {
        setMsg(`Ronde gestart — ${res.count} schilder(s) uitgenodigd.`);
        setTimeout(() => location.reload(), 700);
      }
    });
  }
  function doDispatch() {
    setError(null);
    setMsg(null);
    setLinks(null);
    start(async () => {
      const res = await dispatchNow();
      if (!res.ok) setError(res.error ?? "Versturen mislukt.");
      else setMsg(res.summary ?? "Klaar.");
    });
  }
  function doRegen(id: string) {
    setError(null);
    setMsg(null);
    start(async () => {
      const res = await regenerateLinks(id);
      if (!res.ok) setError(res.error ?? "Mislukt.");
      else setLinks(res.links ?? []);
    });
  }
  function doClose(id: string) {
    setError(null);
    start(async () => {
      const res = await closeRonde(id);
      if (!res.ok) setError(res.error ?? "Sluiten mislukt.");
      else location.reload();
    });
  }

  return (
    <div>
      {error ? <div className="banner err">{error}</div> : null}
      {msg ? <div className="banner ok">{msg}</div> : null}

      {active ? (
        <div className="roundcard">
          <div className="roundcard-head">
            <div>
              <div className="roundcard-title">{active.label ?? "Actieve ronde"}</div>
              <div className="muted">
                {active.respondedCount}/{active.invitesTotal} gereageerd ·{" "}
                {active.pendingCount} nog te versturen · deadline {fmt(active.deadline_at)} ·
                bezoekweek {fmt(active.visit_week_start)}–{fmt(active.visit_week_end)}
              </div>
            </div>
            <span className="pill pill-ok">loopt</span>
          </div>
          <div className="row-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-primary"
              style={{ width: "auto", padding: "9px 16px" }}
              disabled={pending}
              onClick={doDispatch}
            >
              {pending ? "Bezig…" : "Verstuur berichten nu"}
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: "auto", padding: "9px 16px", marginTop: 0 }}
              disabled={pending}
              onClick={() => doRegen(active.id)}
            >
              Toon verzendlinks (handmatig)
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: "auto", padding: "9px 16px", marginTop: 0 }}
              disabled={pending}
              onClick={() => doClose(active.id)}
            >
              Sluit ronde
            </button>
          </div>
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            Berichten gaan automatisch via de cron; &ldquo;Verstuur nu&rdquo; doet het
            direct. In sandbox-modus is dit een test (geen echte WhatsApp).
          </p>
        </div>
      ) : (
        <div className="roundcard">
          <p className="intro">
            Geen actieve ronde. Start er een — alle actieve schilders met opt-in
            krijgen een unieke link via WhatsApp.
          </p>
          <p className="flabel">Naam (optioneel)</p>
          <input
            type="text"
            className="mb10"
            placeholder="bijv. Week 30"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button
            className="btn btn-primary"
            style={{ width: "auto", padding: "10px 18px" }}
            disabled={pending}
            onClick={doStart}
          >
            {pending ? "Bezig…" : "Start ronde"}
          </button>
        </div>
      )}

      {links ? <LinkList links={links} /> : null}
    </div>
  );
}
