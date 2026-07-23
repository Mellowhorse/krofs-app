"use client";

import { useState, useTransition } from "react";
import { buildRouteAction, markVisited } from "./actions";

export type StopPainter = { name: string; phone: string | null };

export type StopView = {
  id: string;
  seq: number;
  dagdeel: string;
  time: string;
  address: string;
  lat: number;
  lng: number;
  painters: StopPainter[];
  legKm: number | null;
  visited: boolean;
};

export type DayView = {
  id: string;
  dateLabel: string;
  distanceKm: number | null;
  durationMin: number | null;
  oversubscribed: boolean;
  mapsUrl: string | null;
  stops: StopView[];
};

export type RoundView = {
  roundId: string;
  label: string;
  status: string;
  planStatus: string | null;
  provider: string | null;
  unrouted: number;
  generatedAt: string | null;
  error: string | null;
};

function StopCard({ stop }: { stop: StopView }) {
  const [visited, setVisited] = useState(stop.visited);
  const [pending, start] = useTransition();

  function toggle() {
    const next = !visited;
    setVisited(next); // optimistic
    start(async () => {
      const res = await markVisited(stop.id, next);
      if (!res.ok) setVisited(!next); // revert on failure
    });
  }

  const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}`;

  return (
    <div className={`stopcard${visited ? " stop-done" : ""}`}>
      <div className="stop-time">{stop.time}</div>
      <div className="stop-body">
        <div className="stop-addr">
          {stop.address}
          <a className="stop-nav" href={navUrl} target="_blank" rel="noreferrer" aria-label="Navigeer hierheen">
            <span aria-hidden>➤</span> navigeer
          </a>
        </div>
        <div className="stop-painters">
          {stop.painters.map((p, i) => (
            <span className="stop-painter" key={i}>
              {p.name}
              {p.phone ? (
                <>
                  <a className="stop-icon" href={`tel:${p.phone}`} aria-label={`Bel ${p.name}`}>
                    bel
                  </a>
                  <a
                    className="stop-icon"
                    href={`https://wa.me/${p.phone.replace(/^\+/, "")}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`WhatsApp ${p.name}`}
                  >
                    app
                  </a>
                </>
              ) : null}
              {i < stop.painters.length - 1 ? <span className="stop-sep"> · </span> : null}
            </span>
          ))}
        </div>
        {stop.legKm != null ? <div className="stop-leg">+{stop.legKm} km rijden</div> : null}
      </div>
      <button
        type="button"
        className={`gezien${visited ? " on" : ""}`}
        onClick={toggle}
        disabled={pending}
        aria-pressed={visited}
      >
        {visited ? "✓ gezien" : "gezien"}
      </button>
    </div>
  );
}

function DaySection({ day }: { day: DayView }) {
  const ochtend = day.stops.filter((s) => s.dagdeel === "ochtend");
  const middag = day.stops.filter((s) => s.dagdeel === "middag");
  return (
    <div className="routeday">
      <div className="routeday-head">
        <h2>{day.dateLabel}</h2>
        <div className="routeday-meta">
          {day.stops.length} adres{day.stops.length === 1 ? "" : "sen"}
          {day.distanceKm != null ? ` · ${day.distanceKm} km` : ""}
          {day.durationMin != null ? ` · ${Math.floor(day.durationMin / 60)}u${String(day.durationMin % 60).padStart(2, "0")}` : ""}
          {day.oversubscribed ? <span className="pill pill-invalid"> vol</span> : null}
        </div>
      </div>
      {day.mapsUrl ? (
        <a className="btn btn-ghost mapsbtn" href={day.mapsUrl} target="_blank" rel="noreferrer">
          Open dag in Google Maps
        </a>
      ) : null}
      {ochtend.length ? <div className="dagdeel-label">Ochtend</div> : null}
      {ochtend.map((s) => (
        <StopCard key={s.id} stop={s} />
      ))}
      {middag.length ? <div className="dagdeel-label">Middag</div> : null}
      {middag.map((s) => (
        <StopCard key={s.id} stop={s} />
      ))}
    </div>
  );
}

export default function RouteClient({ round, days }: { round: RoundView; days: DayView[] }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const hasPlan = round.planStatus === "ready" && days.length > 0;

  function build() {
    setMsg(null);
    setErr(null);
    start(async () => {
      const res = await buildRouteAction(round.roundId);
      if (res.ok) setMsg(res.summary ?? "Route gebouwd.");
      else setErr(res.error ?? "Bouwen mislukt.");
    });
  }

  return (
    <div>
      <div className="routebar">
        <div className="intro" style={{ margin: 0 }}>
          {hasPlan
            ? `Route klaar${round.generatedAt ? ` — ${round.generatedAt}` : ""}${
                round.unrouted ? ` · ${round.unrouted} niet geplaatst` : ""
              }`
            : "Nog geen route voor deze ronde."}
        </div>
        <button type="button" className="btn btn-primary" onClick={build} disabled={pending}>
          {pending ? "Bezig…" : hasPlan ? "Opnieuw bouwen" : "Route bouwen"}
        </button>
      </div>

      {msg ? <p className="ok-msg">{msg}</p> : null}
      {err ? <p className="err">{err}</p> : null}
      {round.error && !hasPlan ? <p className="err">Vorige poging: {round.error}</p> : null}

      {round.unrouted ? (
        <p className="muted">
          {round.unrouted} schilder{round.unrouted === 1 ? "" : "s"} met een adres dat nog
          gecontroleerd moet worden — die staan niet in de route.
        </p>
      ) : null}

      {days.map((d) => (
        <DaySection key={d.id} day={d} />
      ))}
    </div>
  );
}
