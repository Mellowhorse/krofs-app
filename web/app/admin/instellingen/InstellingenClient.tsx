"use client";

import { useState, useTransition } from "react";
import { saveSettings, lookupStart } from "./actions";

export type Settings = {
  visitMinutes: number;
  dayStart: string;
  dayEnd: string;
  maxVisits: number;
  deadlineDays: number;
  startLabel: string;
  startLat: number;
  startLng: number;
};

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
};

export default function InstellingenClient({ initial }: { initial: Settings }) {
  const [s, setS] = useState<Settings>(initial);
  const [editStart, setEditStart] = useState(false);
  const [pc, setPc] = useState("");
  const [nr, setNr] = useState("");
  const [lookMsg, setLookMsg] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [looking, startLook] = useTransition();

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setS((prev) => ({ ...prev, [k]: v }));
    setMsg(null);
  }

  // ~ hoeveel bezoeken past er op een hele dag
  const window = Math.max(0, toMin(s.dayEnd) - toMin(s.dayStart));
  const perStop = s.visitMinutes + 15;
  const past = perStop > 0 ? Math.floor(window / perStop) : 0;
  const perDag = Math.max(0, Math.min(past, s.maxVisits));
  const hint =
    window <= 0
      ? "De eindtijd moet na de begintijd liggen."
      : `Met deze instellingen plan je ongeveer ${perDag} bezoek${perDag === 1 ? "" : "en"} op een hele dag` +
        (past > s.maxVisits ? " (begrensd door je maximum)." : ".");

  function zoekStart() {
    setLookMsg(null);
    startLook(async () => {
      const r = await lookupStart(pc, nr);
      if (!r.ok) setLookMsg(r.error ?? "Niet gevonden.");
      else {
        setS((prev) => ({ ...prev, startLabel: r.label!, startLat: r.lat!, startLng: r.lng! }));
        setEditStart(false);
        setPc("");
        setNr("");
        setMsg(null);
      }
    });
  }

  function opslaan() {
    setErr(null);
    setMsg(null);
    start(async () => {
      const res = await saveSettings(s);
      if (!res.ok) setErr(res.error ?? "Opslaan mislukt.");
      else setMsg("Opgeslagen.");
    });
  }

  return (
    <div className="roundcard" style={{ maxWidth: 560 }}>
      <div className="seclabel">Je werkdag</div>
      <div className="grid2 mb10" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <p className="flabel">Tijd per bezoek</p>
          <select className="sel" value={s.visitMinutes} onChange={(e) => set("visitMinutes", +e.target.value)}>
            {[15, 20, 30, 45, 60].map((v) => (
              <option key={v} value={v}>{v} minuten</option>
            ))}
          </select>
        </div>
        <div>
          <p className="flabel">Max. bezoeken per dag</p>
          <input type="number" min={1} max={30} value={s.maxVisits} onChange={(e) => set("maxVisits", +e.target.value)} />
        </div>
        <div>
          <p className="flabel">Werkdag van</p>
          <input type="time" value={s.dayStart} onChange={(e) => set("dayStart", e.target.value)} />
        </div>
        <div>
          <p className="flabel">tot</p>
          <input type="time" value={s.dayEnd} onChange={(e) => set("dayEnd", e.target.value)} />
        </div>
      </div>
      <p className="ok-msg" style={{ margin: "2px 0 18px" }}>{hint}</p>

      <div className="seclabel">Uitvraag</div>
      <p className="flabel">Schilders krijgen</p>
      <select className="sel" style={{ maxWidth: 220 }} value={s.deadlineDays} onChange={(e) => set("deadlineDays", +e.target.value)}>
        {[3, 4, 5, 7].map((v) => (
          <option key={v} value={v}>{v} dagen</option>
        ))}
      </select>
      <p className="muted" style={{ fontSize: 13, margin: "6px 0 18px" }}>
        om in te vullen. Daarna sluit de ronde automatisch en kun je de route bouwen.
      </p>

      <div className="seclabel">Startpunt</div>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
        Elke routedag begint hier.
      </p>
      {!editStart ? (
        <div className="startrow">
          <span>{s.startLabel}</span>
          <button className="btn-sm" onClick={() => setEditStart(true)}>Wijzigen</button>
        </div>
      ) : (
        <div className="startedit">
          <div className="grid2" style={{ gridTemplateColumns: "1fr 100px", gap: 8 }}>
            <div>
              <p className="flabel">Postcode</p>
              <input value={pc} onChange={(e) => setPc(e.target.value)} placeholder="1234 AB" />
            </div>
            <div>
              <p className="flabel">Huisnr.</p>
              <input value={nr} onChange={(e) => setNr(e.target.value)} inputMode="numeric" />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn-sm btn-wa" onClick={zoekStart} disabled={looking}>
              {looking ? "Zoeken…" : "Zoek adres"}
            </button>
            <button className="btn-sm" onClick={() => { setEditStart(false); setLookMsg(null); }}>Annuleer</button>
          </div>
          {lookMsg ? <p className="err" style={{ marginTop: 6 }}>{lookMsg}</p> : null}
        </div>
      )}

      <div style={{ marginTop: 22 }}>
        <button className="btn btn-primary" style={{ width: "auto", padding: "9px 18px" }} disabled={pending} onClick={opslaan}>
          {pending ? "Opslaan…" : "Opslaan"}
        </button>
        {msg ? <span className="ok-msg" style={{ marginLeft: 12 }}>{msg}</span> : null}
        {err ? <p className="err" style={{ marginTop: 8 }}>{err}</p> : null}
      </div>
    </div>
  );
}
