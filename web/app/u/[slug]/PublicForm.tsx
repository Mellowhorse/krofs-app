"use client";

import { useMemo, useState } from "react";
import { submitPublicAction, lookupAddressAction } from "./actions";
import type { RoundView } from "@/lib/supabaseAdmin";

const WD = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const MONTHS = [
  "jan", "feb", "mrt", "apr", "mei", "jun",
  "jul", "aug", "sep", "okt", "nov", "dec",
];

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function reasonNL(reason?: string): string {
  switch (reason) {
    case "name_required":
      return "Vul je naam in.";
    case "phone_invalid":
      return "Vul een geldig 06-nummer in.";
    case "workday_out_of_window":
      return "Kies een dag binnen de aangeboden week.";
    case "address_incomplete":
      return "Vul straat, huisnummer en plaats in.";
    case "no_workdays":
      return "Kies minstens één dag.";
    case "closed":
    case "not_found":
      return "Deze uitvraag is gesloten of de link is niet meer geldig.";
    case "opted_out":
      return "Dit nummer ontvangt geen berichten meer. Neem contact op met Kees.";
    default:
      return "Er ging iets mis. Probeer het zo nog eens.";
  }
}

type LookState = "idle" | "searching" | "found" | "notfound" | "invalid";

export default function PublicForm({
  slug,
  round,
}: {
  slug: string;
  round: RoundView;
}) {
  const days = useMemo(() => {
    const start = parseYmd(round.visit_week_start);
    return Array.from({ length: 5 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return { value: ymd(d), label: WD[i], num: d.getDate() };
    });
  }, [round.visit_week_start]);

  const weekLabel = useMemo(() => {
    const s = parseYmd(round.visit_week_start);
    const e = parseYmd(round.visit_week_end);
    return `${s.getDate()}–${e.getDate()} ${MONTHS[e.getMonth()]}`;
  }, [round.visit_week_start, round.visit_week_end]);

  const [naam, setNaam] = useState("");
  const [telefoon, setTelefoon] = useState("");
  const [postcode, setPostcode] = useState("");
  const [huisnummer, setHuisnummer] = useState("");
  const [straat, setStraat] = useState("");
  const [plaats, setPlaats] = useState("");
  const [look, setLook] = useState<LookState>("idle");
  const [manual, setManual] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<null | "ok" | "nowork">(null);

  function toggle(v: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  // Reset the resolved address when the postcode/huisnummer change again.
  function onPc(v: string) {
    setPostcode(v);
    if (look === "found") { setLook("idle"); setManual(false); }
  }
  function onNr(v: string) {
    setHuisnummer(v);
    if (look === "found") { setLook("idle"); setManual(false); }
  }

  async function doLookup(): Promise<boolean> {
    if (!postcode.trim() || !huisnummer.trim()) {
      setLook("invalid");
      return false;
    }
    setLook("searching");
    const res = await lookupAddressAction(postcode, huisnummer);
    if (res.ok) {
      setStraat(res.straat);
      setPlaats(res.plaats);
      setPostcode(res.postcode);
      setHuisnummer(res.huisnummer);
      setManual(false);
      setLook("found");
      return true;
    }
    if (res.reason === "invalid") {
      setLook("invalid");
      return false;
    }
    setManual(true); // not_found / error -> let them fill straat + plaats
    setLook("notfound");
    return false;
  }

  async function submit(noWork: boolean) {
    setErr(null);
    if (!naam.trim()) return setErr("Vul je naam in.");
    if (!telefoon.trim()) return setErr("Vul je 06-nummer in.");

    const workdays = [...selected].sort();
    if (!noWork) {
      if (!postcode.trim() || !huisnummer.trim())
        return setErr("Vul postcode en huisnummer in.");
      // resolve the address if the schilder didn't press "Zoek adres" yet
      if (look !== "found" && !manual) {
        setSubmitting(true);
        const ok = await doLookup();
        setSubmitting(false);
        if (!ok) {
          return setErr(
            manual || look === "notfound"
              ? "Vul straat en plaats even zelf in."
              : "Controleer postcode en huisnummer.",
          );
        }
      }
      if (!straat.trim() || !plaats.trim())
        return setErr("Vul straat en plaats in.");
      if (workdays.length === 0)
        return setErr('Kies minstens één dag, of tik "ik werk deze week niet".');
    }

    setSubmitting(true);
    const res = await submitPublicAction({
      slug,
      name: naam,
      phone: telefoon,
      straat,
      huisnummer,
      postcode,
      plaats,
      workdays,
      noWork,
    });
    setSubmitting(false);
    if (res.ok) setDone(noWork ? "nowork" : "ok");
    else setErr(reasonNL(res.reason));
  }

  if (done) {
    const chosen = [...selected]
      .sort()
      .map((v) => {
        const d = days.find((x) => x.value === v);
        return d ? `${d.label} ${d.num}` : v;
      })
      .join(" · ");
    return (
      <div className="wrap">
        <div className="card">
          <div className="body done">
            <div className="check" aria-hidden>
              &#10003;
            </div>
            <h2>Bedankt, {naam.trim().split(" ")[0]}!</h2>
            <p>
              We hebben je gegevens ontvangen. Kees plant zijn route en je hoort
              wanneer hij langskomt.
            </p>
            {done === "ok" ? (
              <div className="summary">
                <div className="k">Locatie</div>
                <div className="v">
                  {straat} {huisnummer}
                  {postcode ? `, ${postcode}` : ""} {plaats}
                </div>
                <div className="k">Dagen</div>
                <div className="v">{chosen || "—"}</div>
              </div>
            ) : (
              <div className="summary">
                <div className="v">Je gaf aan deze week niet te werken.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="card">
        <div className="urlbar">&#128274; krofs-planner.nl/u/…</div>
        <div className="body">
          <div className="brand">
            <div className="logo">K</div>
            <div>
              <div className="name">Krofs</div>
              <div className="sub">schildersplanning</div>
            </div>
          </div>

          <h1>Waar werk je?</h1>
          <p className="intro">
            Kees komt binnenkort langs voor een kop koffie. Laat weten waar je
            werkt in de week van {weekLabel} en op welke dagen.
          </p>

          <div className="seclabel">Wie ben je?</div>
          <p className="flabel">Naam</p>
          <input
            type="text"
            className="mb10"
            value={naam}
            onChange={(e) => setNaam(e.target.value)}
            autoComplete="name"
          />
          <p className="flabel">Telefoon (06-nummer)</p>
          <input
            type="tel"
            inputMode="tel"
            value={telefoon}
            onChange={(e) => setTelefoon(e.target.value)}
            autoComplete="tel"
          />

          <div className="seclabel">Waar werk je?</div>
          <div className="grid2 mb10">
            <div>
              <p className="flabel">Postcode</p>
              <input
                type="text"
                value={postcode}
                onChange={(e) => onPc(e.target.value)}
                placeholder="1234 AB"
                autoComplete="postal-code"
              />
            </div>
            <div>
              <p className="flabel">Huisnr.</p>
              <input
                type="text"
                value={huisnummer}
                onChange={(e) => onNr(e.target.value)}
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
                &#10003; {straat} {huisnummer}, {postcode} {plaats}
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
                value={straat}
                onChange={(e) => setStraat(e.target.value)}
                autoComplete="off"
              />
              <p className="flabel">Plaats</p>
              <input
                type="text"
                value={plaats}
                onChange={(e) => setPlaats(e.target.value)}
                autoComplete="off"
              />
            </div>
          ) : null}

          <div className="seclabel">Op welke dagen ben je daar?</div>
          <div className="weeklabel">Week van {weekLabel}</div>
          <div className="days">
            {days.map((d) => (
              <button
                key={d.value}
                type="button"
                className={`daypill${selected.has(d.value) ? " sel" : ""}`}
                aria-pressed={selected.has(d.value)}
                onClick={() => toggle(d.value)}
              >
                {d.label}
                <br />
                {d.num}
              </button>
            ))}
          </div>

          {err ? <p className="err">{err}</p> : null}

          <button
            type="button"
            className="btn btn-primary"
            disabled={submitting}
            onClick={() => submit(false)}
          >
            {submitting ? "Versturen…" : "Versturen"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={submitting}
            onClick={() => submit(true)}
          >
            Ik werk deze week niet
          </button>
        </div>
      </div>
    </div>
  );
}
