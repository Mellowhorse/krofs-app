"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  startRonde,
  dispatchNow,
  regenerateLinks,
  closeRonde,
  type SendLink,
} from "./actions";

export type MissingPainter = { id: string; name: string; phone: string };

export type ActiveRound = {
  id: string;
  label: string | null;
  deadline_at: string | null;
  visit_week_start: string | null;
  visit_week_end: string | null;
  rosterTotal: number;
  respondedCount: number;
  missing: MissingPainter[];
  shareUrl: string | null;
};

function fmt(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn-sm btn-wa"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Gekopieerd" : label}
    </button>
  );
}

function ShareLink({ url }: { url: string }) {
  return (
    <div className="sharebox">
      <div className="sharebox-title">Deel deze link in je WhatsApp-verzendlijst</div>
      <p className="muted" style={{ fontSize: 13, margin: "2px 0 8px" }}>
        Eén link voor iedereen. De schilder vult zelf naam, 06-nummer, postcode +
        huisnummer en dagen in. Vraag ze wel je nummer op te slaan, anders komt een
        broadcast niet aan.
      </p>
      <div className="sharerow">
        <input className="shareinput" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <CopyButton text={url} label="Kopieer link" />
      </div>
    </div>
  );
}

function MissingList({ round }: { round: ActiveRound }) {
  const url = round.shareUrl ?? "";
  const broadcastReminder =
    `Hoi! 👋 Kleine herinnering van Kees (Krofs) — ik hoor graag nog even waar je werkt ` +
    `en op welke dagen, zodat ik langs kan komen. Invullen kan hier: ${url}`;

  if (round.rosterTotal === 0) {
    return (
      <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
        Nog geen schilderslijst geïmporteerd — daardoor kan ik niet tonen wie nog niet
        gereageerd heeft. Importeer je lijst via <b>Schilders importeren</b>.
      </p>
    );
  }

  return (
    <div className="missing">
      <div className="missing-head">
        <Link className="linkbtn" href="/admin/reacties">
          {round.missing.length
            ? `Nog geen reactie (${round.missing.length}) — bekijk wie →`
            : `Iedereen heeft gereageerd — bekijk de antwoorden →`}
        </Link>
        {url && round.missing.length ? (
          <CopyButton text={broadcastReminder} label="Kopieer reminder-tekst" />
        ) : null}
      </div>
    </div>
  );
}

function LinkList({ links }: { links: SendLink[] }) {
  return (
    <div className="links">
      <p className="intro">
        {links.length} persoonlijke link{links.length === 1 ? "" : "s"}. Tik
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
            <CopyButton text={l.url} label="Kopieer link" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RondeClient({ active }: { active: ActiveRound | null }) {
  const [links, setLinks] = useState<SendLink[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function doStart() {
    setError(null);
    setMsg(null);
    start(async () => {
      const res = await startRonde();
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
                {active.respondedCount} van {active.rosterTotal} gereageerd
                {active.missing.length ? ` · ${active.missing.length} nog niet` : ""} ·
                deadline {fmt(active.deadline_at)} · bezoekweek{" "}
                {fmt(active.visit_week_start)}–{fmt(active.visit_week_end)}
              </div>
            </div>
            <span className="pill pill-ok">loopt</span>
          </div>

          {active.shareUrl ? <ShareLink url={active.shareUrl} /> : null}
          <MissingList round={active} />

          <div className="row-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-ghost"
              style={{ width: "auto", padding: "9px 16px", marginTop: 0 }}
              disabled={pending}
              onClick={() => doRegen(active.id)}
            >
              Persoonlijke links (los van de verzendlijst)
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: "auto", padding: "9px 16px", marginTop: 0 }}
              disabled={pending}
              onClick={doDispatch}
            >
              {pending ? "Bezig…" : "Automatisch versturen (Meta)"}
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
        </div>
      ) : (
        <div className="roundcard">
          <p className="intro">
            Geen actieve ronde. Start er een — je krijgt dan één deelbare link voor je
            WhatsApp-verzendlijst.
          </p>
          <p className="muted" style={{ fontSize: 13, margin: "0 0 12px" }}>
            De datums volgen automatisch uit het moment van starten: schilders kunnen{" "}
            <b>5 dagen</b> invullen, daarna sluit de ronde, en de <b>bezoekweek</b> is de
            eerste hele werkweek (ma–vr) daarna. De ronde krijgt die bezoekweek als naam.
          </p>
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
