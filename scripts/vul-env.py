#!/usr/bin/env python3
"""Vul .env veilig vanaf het klembord — voorkomt plak-schade uit TextEdit.

Gebruik:  python3 scripts/vul-env.py
Het script vraagt je stap voor stap iets te kopiëren in het Supabase-dashboard
en leest het dan zelf van je klembord. Elke waarde wordt gevalideerd vóór hij
in .env wordt gezet. Er wordt nooit een geheime waarde op het scherm getoond.
"""
import base64
import getpass
import json
import re
import subprocess
import sys
from pathlib import Path

ENV = Path(__file__).resolve().parent.parent / ".env"


def pbpaste() -> str:
    return subprocess.run(["pbpaste"], capture_output=True, text=True).stdout.strip()


def set_env(key: str, value: str) -> None:
    raw = ENV.read_text()
    pattern = rf"^{key}=.*$"
    if re.search(pattern, raw, re.M):
        raw = re.sub(pattern, f"{key}={value}", raw, count=1, flags=re.M)
    else:
        raw += f"\n{key}={value}\n"
    ENV.write_text(raw)


def jwt_ok(v: str) -> str | None:
    v = "".join(v.split())  # alle witruimte eruit
    parts = v.split(".")
    if len(parts) != 3:
        return None
    try:
        pad = parts[1] + "=" * (-len(parts[1]) % 4)
        json.loads(base64.urlsafe_b64decode(pad))
    except Exception:
        return None
    if len(parts[2]) != 43:  # HS256-handtekening is altijd 43 base64url-tekens
        return None
    return v


def vraag_jwt(label: str, env_key: str, verwachte_rol: str) -> None:
    while True:
        input(f"\n1) Kopieer in Supabase de {label} (gebruik de KOPIEER-KNOP)\n2) Druk hier op Enter... ")
        v = jwt_ok(pbpaste())
        if v is None:
            print("   ✗ Dat is geen intacte key — kopieer opnieuw met de kopieerknop.")
            continue
        pad = v.split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(pad + "=" * (-len(pad) % 4)))
        if payload.get("role") != verwachte_rol:
            print(f"   ✗ Deze key heeft rol '{payload.get('role')}', verwacht '{verwachte_rol}' — je hebt de verkeerde gekopieerd.")
            continue
        set_env(env_key, v)
        print(f"   ✓ {env_key} gezet (rol {verwachte_rol}, project {payload.get('ref')})")
        return


def vraag_dburl() -> None:
    while True:
        input(
            "\n1) Klik in Supabase op 'Connect' (bovenin) -> tab 'Connection String' -> type URI\n"
            "2) Kopieer de SESSION POOLER-regel (begint met postgresql://, host bevat 'pooler')\n"
            "3) Druk hier op Enter... "
        )
        v = "".join(pbpaste().split())
        if not re.match(r"^postgres(ql)?://\S+@\S+:\d{4,5}/postgres$", v):
            print("   ✗ Dat lijkt geen connection string — kopieer de hele URI-regel.")
            continue
        if "pooler" not in v:
            print("   ⚠ Dit is de directe verbinding (werkt vaak niet op thuisnetwerken). Pak de Session pooler-variant.")
            continue
        if "[YOUR-PASSWORD]" in v:
            pw = getpass.getpass("   Typ je database-wachtwoord (blijft onzichtbaar): ").strip()
            if not pw:
                print("   ✗ Leeg wachtwoord."); continue
            if any(c in pw for c in "@:/#?[]"):
                print("   ✗ Wachtwoord bevat @ : / # ? of []. Reset het in Supabase naar alleen letters+cijfers en probeer opnieuw.")
                continue
            v = v.replace("[YOUR-PASSWORD]", pw)
        set_env("SUPABASE_DB_URL", v)
        print("   ✓ SUPABASE_DB_URL gezet")
        return


def main() -> None:
    if not ENV.exists():
        print(f"✗ {ENV} bestaat niet."); sys.exit(1)
    print("=== Supabase-gegevens veilig invullen ===")
    print("Open het dashboard: Project Settings -> API keys")
    vraag_jwt("anon / public key", "SUPABASE_ANON_KEY", "anon")
    vraag_jwt("service_role / secret key", "SUPABASE_SERVICE_ROLE_KEY", "service_role")
    vraag_dburl()
    print("\n✓ Klaar. Zeg in de chat 'done' — dan wordt de verbinding getest.")


if __name__ == "__main__":
    main()
