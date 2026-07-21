"use client";

import { useState, useTransition } from "react";
import { geocodeNowAction } from "./actions";

export default function GeocodeButton({ count }: { count: number }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        className="btn-sm btn-wa"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await geocodeNowAction();
            setMsg(
              r.ok || r.review
                ? `${r.ok} adres(sen) gevonden${r.review ? `, ${r.review} te controleren` : ""}.`
                : "Niets te doen.",
            );
          })
        }
      >
        {pending ? "Bezig…" : `Zoek ${count} adres${count === 1 ? "" : "sen"} nu op`}
      </button>
      {msg ? (
        <span className="muted" style={{ fontSize: 13, marginLeft: 10 }}>
          {msg}
        </span>
      ) : null}
    </div>
  );
}
