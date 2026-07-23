"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  startRonde,
  dispatchNow,
  regenerateLinks,
  closeRonde,
  cancelRonde,
  type SendLink,
} from "./actions";

export type MissingPainter = { id: string; name: string; phone: string };
export type WeekOption = { value: string; label: string };

export type Dagdeel = "niet" | "heel" | "ochtend" | "middag";
export type DagdeelInfo = Record<
  Exclude<Dagdeel, "niet">,
  { label: string; cap: number }
>;

const WD = ["ma", "di", "wo", "do", "vr"];
const DEEL_LABEL: Record<Dagdeel, string> = {
  niet: "niet",
  heel: "hele dag",
  ochtend: "ochtend",
  middag: "middag",
};

// Dagnummers van de gekozen week (maandag t/m vrijdag).
function weekDates(monday: string): number[] {
  const [y, m, d] = monday.split("-").map(Number);
  return Array.from({ length: 5 }, (_, i) => {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    return dt.getUTCDate();
  });
}

function NieuweRonde({
  weeks,
  laatsteInvuldag,
  dagdelen,
  pending,
  onStart,
}: {
  weeks: WeekOption[];
  laatsteInvuldag: string;
  dagdelen: DagdeelInfo;
  pending: boolean;
  onStart: (week: string, parts: Record<string, Dagdeel>) => void;
}) {
  const [week, setWeek] = useState(weeks[0]?.value ?? "");
  // Standaard is elke dag een hele dag; Kees zet alleen de uitzonderingen om.
  const [parts, setParts] = useState<Record<number, Dagdeel>>({
    1: "heel", 2: "heel", 3: "heel", 4: "heel", 5: "heel",
  });
  const nums = week ? weekDates(week) : [];

  const beschikbaar = [1, 2, 3, 4, 5].filter((n) => parts[n] !== "niet");
  const totaal = beschikbaar.reduce(
    (s, n) => s + dagdelen[parts[n] as Exclude<Dagdeel, "niet">].cap,
    0,
  );

  return (
    <div className="roundcard">
      <p className="intro">
        Nieuwe ronde. Schilders kunnen invullen t/m <b>{laatsteInvuldag}</b>; daarna
        sluit de ronde automatisch.
      </p>

      <p className="flabel">Welke week ga je langs?</p>
      <select
        className="mb10"
        value={week}
        onChange={(e) => setWeek(e.target.value)}
        style={{
          width: "100%",
          padding: "10px 12px",
          fontSize: 14,
          borderRadius: 10,
          border: "0.5px solid var(--border-strong)",
          background: "#fff",
          color: "var(--text)",
        }}
      >
        {weeks.map((w) => (
          <option key={w.value} value={w.value}>
            {w.label}
          </option>
        ))}
      </select>

      <p className="flabel">
        Wanneer kun jij langs? Zet de dagen die niet lukken op <b>niet</b>.
      </p>
      <div className="dagkeuze">
        {WD.map((label, i) => {
          const n = i + 1;
          const deel = parts[n];
          const uit = deel === "niet";
          return (
            <div className={`dagrij${uit ? " dag-uit" : ""}`} key={label}>
              <span className="dagrij-label">
                {label} {nums[i] ?? ""}
              </span>
              {(["niet", "heel", "ochtend", "middag"] as Dagdeel[]).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`deelknop${deel === opt ? (opt === "niet" ? " sel-uit" : " sel") : ""}`}
                  aria-pressed={deel === opt}
                  onClick={() => setParts((p) => ({ ...p, [n]: opt }))}
                >
                  {DEEL_LABEL[opt]}
                </button>
              ))}
              <span className="dagrij-info">
                {uit
                  ? "niet beschikbaar"
                  : `${dagdelen[deel as Exclude<Dagdeel, "niet">].label} · ~${dagdelen[deel as Exclude<Dagdeel, "niet">].cap} bezoeken`}
              </span>
            </div>
          );
        })}
      </div>

      <p className={beschikbaar.length ? "ok-msg" : "err"} style={{ margin: "10px 0 14px" }}>
        {beschikbaar.length
          ? `Ruimte voor ongeveer ${totaal} bezoeken deze week, verdeeld over ${beschikbaar.length} dag${beschikbaar.length === 1 ? "" : "en"}.`
          : "Kies minstens één dag waarop je langs kunt."}
      </p>

      <button
        className="btn btn-primary"
        style={{ width: "auto", padding: "10px 18px" }}
        disabled={pending || !week || beschikbaar.length === 0}
        onClick={() =>
          onStart(
            week,
            Object.fromEntries(beschikbaar.map((n) => [String(n), parts[n]])),
          )
        }
      >
        {pending ? "Bezig…" : "Start ronde"}
      </button>
    </div>
  );
}

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

export default function RondeClient({
  active,
  weeks,
  laatsteInvuldag,
  dagdelen,
}: {
  active: ActiveRound | null;
  weeks: WeekOption[];
  laatsteInvuldag: string;
  dagdelen: DagdeelInfo;
}) {
  const [links, setLinks] = useState<SendLink[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function doStart(week: string, parts: Record<string, Dagdeel>) {
    setError(null);
    setMsg(null);
    start(async () => {
      const res = await startRonde(week, parts);
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
    if (
      !window.confirm(
        "Uitvraag nu sluiten?\n\nDe deelbare link werkt daarna niet meer, dus schilders kunnen niet meer invullen. De reacties blijven bewaard zodat je de route kunt bouwen.",
      )
    )
      return;
    start(async () => {
      const res = await closeRonde(id);
      if (!res.ok) setError(res.error ?? "Sluiten mislukt.");
      else location.reload();
    });
  }
  function doCancel(id: string) {
    setError(null);
    if (
      !window.confirm(
        "Ronde annuleren en verwijderen?\n\nDe hele ronde én alle reacties worden gewist. Gebruik dit als je per ongeluk de verkeerde week of dagen koos. Dit kan niet ongedaan worden gemaakt.",
      )
    )
      return;
    start(async () => {
      const res = await cancelRonde(id);
      if (!res.ok) setError(res.error ?? "Annuleren mislukt.");
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
              onClick={() => doClose(active.id)}
            >
              Uitvraag nu sluiten
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: "auto", padding: "9px 16px", marginTop: 0, color: "#a32d2d", borderColor: "#e8b4b4" }}
              disabled={pending}
              onClick={() => doCancel(active.id)}
            >
              Ronde annuleren
            </button>
          </div>

          <details className="meer-opties">
            <summary>Meer opties</summary>
            <div className="row-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <button
                className="btn btn-ghost"
                style={{ width: "auto", padding: "9px 16px", marginTop: 0 }}
                disabled={pending}
                onClick={() => doRegen(active.id)}
              >
                Persoonlijke links tonen
              </button>
              <button
                className="btn btn-ghost"
                style={{ width: "auto", padding: "9px 16px", marginTop: 0 }}
                disabled={pending}
                onClick={doDispatch}
              >
                {pending ? "Bezig…" : "Automatisch versturen (Meta)"}
              </button>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Voor de meeste rondes niet nodig — je deelt gewoon de link hierboven in je
              WhatsApp-verzendlijst.
            </p>
          </details>
        </div>
      ) : (
        <NieuweRonde
          weeks={weeks}
          laatsteInvuldag={laatsteInvuldag}
          dagdelen={dagdelen}
          pending={pending}
          onStart={doStart}
        />
      )}

      {links ? <LinkList links={links} /> : null}
    </div>
  );
}
