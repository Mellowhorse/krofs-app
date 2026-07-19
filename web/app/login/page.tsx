"use client";

import { useActionState } from "react";
import { signIn } from "./actions";
import Logo from "@/app/Logo";

export default function LoginPage() {
  const [state, action, pending] = useActionState(signIn, null);
  return (
    <div className="wrap">
      <div className="card" style={{ maxWidth: 380 }}>
        <div className="body">
          <div className="brandmark">
            <Logo height={72} />
          </div>
          <h1>Inloggen</h1>
          <form action={action}>
            <p className="flabel">E-mail</p>
            <input
              type="text"
              name="email"
              className="mb10"
              autoComplete="username"
              inputMode="email"
            />
            <p className="flabel">Wachtwoord</p>
            <input
              type="password"
              name="password"
              className="mb10"
              autoComplete="current-password"
            />
            {state?.error ? <p className="err">{state.error}</p> : null}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pending}
              style={{ marginTop: 8 }}
            >
              {pending ? "Bezig…" : "Inloggen"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
