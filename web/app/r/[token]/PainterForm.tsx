"use client";

import { useMemo, useState } from "react";
import { submitAction } from "./actions";
import type { InviteView } from "@/lib/supabaseAdmin";

const WD = ["ma", "di", "wo", "do", "vr", "za", "zo"];

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
const MONTHS = [
  "jan", "feb", "mrt", "apr", "mei", "jun",
  "jul", "aug", "sep", "okt", "nov", "dec",
];

function reasonNL(reason?: string): string {
  switch (reason) {
    case "workday_out_of_window":
      return "Kies een dag binnen de aangeboden week.";
    case "address_incomplete":
      return "Vul straat, huisnummer en plaats in.";
    case "no_workdays":
      return "Kies minstens één dag.";
    case "used":
    case "expired":
    case "not_found":
    case "no_expiry":
    case "not_yet_valid":
    case "opted_out":
      return "Deze link is niet meer geldig. Neem contact op met Kees.";
    default:
      return "Er ging iets mis. Probeer het zo nog eens.";
  }
}

export default function PainterForm({
  token,
  invite,
}: {
  token: string;
  invite: InviteView;
}) {
  const firstName = invite.painter_name?.split(" ")[0] ?? "";
  const days = useMemo(() => {
    const start = parseYmd(invite.visit_week_start);
    return Array.from({ length: 5 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return { value: ymd(d), label: WD[i], num: d.getDate() };
    });
  }, [invite.visit_week_start]);

  const weekLabel = useMemo(() => {
    const s = parseYmd(invite.visit_week_start);
    const e = parseYmd(invite.visit_week_end);
    return `${s.getDate()}–${e.getDate()} ${MONTHS[e.getMonth()]}`;
  }, [invite.visit_week_start, invite.visit_week_end]);

  const [straat, setStraat] = useState(invite.prefill?.straat ?? "");
  const [huisnummer, setHuisnummer] = useState(invite.prefill?.huisnummer ?? "");
  const [postcode, setPostcode] = useState(invite.prefill?.postcode ?? "");
  const [plaats, setPlaats] = useState(invite.prefill?.plaats ?? "");
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

  async function submit(noWork: boolean) {
    setErr(null);
    const workdays = [...selected].sort();
    if (!noWork) {
      if (!straat.trim() || !huisnummer.trim() || !plaats.trim()) {
        setErr("Vul straat, huisnummer en plaats in.");
        return;
      }
      if (workdays.length === 0) {
        setErr('Kies minstens één dag, of tik "ik werk deze week niet".');
        return;
      }
    }
    setSubmitting(true);
    const res = await submitAction({
      token,
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
            <h2>Bedankt{firstName ? `, ${firstName}` : ""}!</h2>
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
        <div className="urlbar">&#128274; krofs-planner.nl/r/…</div>
        <div className="body">
          <div className="brand">
            <div className="logo">K</div>
            <div>
              <div className="name">Krofs</div>
              <div className="sub">schildersplanning</div>
            </div>
          </div>

          <h1>Hoi{firstName ? ` ${firstName}` : ""},</h1>
          <p className="intro">
            Kees komt binnenkort langs voor een kop koffie. Laat weten waar je
            werkt in de week van {weekLabel} en op welke dagen.
          </p>

          <div className="seclabel">Waar werk je?</div>
          {invite.prefill ? (
            <p className="weeklabel">
              Vorige keer: {invite.prefill.straat} {invite.prefill.huisnummer},{" "}
              {invite.prefill.plaats}. Klopt dat nog? Pas anders aan.
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
          <div className="grid2 mb10">
            <div>
              <p className="flabel">Huisnr.</p>
              <input
                type="text"
                value={huisnummer}
                onChange={(e) => setHuisnummer(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div>
              <p className="flabel">Postcode</p>
              <input
                type="text"
                value={postcode}
                onChange={(e) => setPostcode(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          <p className="flabel">Plaats</p>
          <input
            type="text"
            value={plaats}
            onChange={(e) => setPlaats(e.target.value)}
            autoComplete="off"
          />

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
