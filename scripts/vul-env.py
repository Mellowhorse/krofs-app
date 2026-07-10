#!/usr/bin/env python3
"""Vul .env veilig vanaf het klembord — voorkomt plak-schade uit TextEdit.

Gebruik:
  python3 scripts/vul-env.py         # alle drie (anon, service_role, db-url)
  python3 scripts/vul-env.py db      # alleen de database-URL

Het script leest waarden van je klembord, valideert ze, en test bij de
database-URL meteen een echte verbinding (en probeert automatisch de juiste
regio-host als de gekopieerde host niet verbindt). Er wordt nooit een geheime
waarde op het scherm getoond.
"""
import base64
import getpass
import json
import re
import subprocess
import sys
from pathlib import Path

ENV = Path(__file__).resolve().parent.parent / ".env"

REGIONS = [
    "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3",
    "us-east-1", "us-east-2", "us-west-1", "us-west-2",
    "ap-southeast-1", "ap-southeast-2", "ap-south-1",
    "ap-northeast-1", "ap-northeast-2", "ca-central-1", "sa-east-1",
]


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


def jwt_ok(v: str):
    v = "".join(v.split())
    parts = v.split(".")
    if len(parts) != 3 or len(parts[2]) != 43:
        return None
    try:
        pad = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(pad))
    except Exception:
        return None
    return v, payload


def vraag_jwt(label: str, env_key: str, rol: str) -> None:
    while True:
        input(f"\n> Kopieer in Supabase (Settings -> API keys) de {label} met de KOPIEER-KNOP, druk Enter... ")
        res = jwt_ok(pbpaste())
        if res is None:
            print("   x geen intacte key op je klembord — kopieer opnieuw met de knop.")
            continue
        v, payload = res
        if payload.get("role") != rol:
            print(f"   x rol is '{payload.get('role')}', verwacht '{rol}' — verkeerde key gekopieerd.")
            continue
        set_env(env_key, v)
        print(f"   ok {env_key} gezet (rol {rol})")
        return


def db_connect(url: str):
    import psycopg2
    return psycopg2.connect(url, connect_timeout=10)


def probe(url: str):
    """Test url; op 'tenant not found' alle regio-hosts proberen. Geeft werkende url of None."""
    m = re.match(r"^postgres(?:ql)?://(?P<user>[^:]+):(?P<pw>[^@]+)@(?P<host>[^:]+):(?P<port>\d+)/postgres$", url)
    if not m:
        return None, "URL-formaat onbekend"
    candidates = [url]
    if "pooler.supabase.com" in m["host"]:
        for region in REGIONS:
            for pref in ("aws-1", "aws-0"):
                h = f"{pref}-{region}.pooler.supabase.com"
                if h != m["host"]:
                    candidates.append(f"postgresql://{m['user']}:{m['pw']}@{h}:{m['port']}/postgres")
    last = ""
    for i, c in enumerate(candidates):
        try:
            conn = db_connect(c)
            conn.close()
            return c, None
        except Exception as e:
            last = str(e).replace(m["pw"], "***")
            if "not found" not in last.lower() and "translate host" not in last.lower():
                # echte fout (wachtwoord/db) — niet blijven proberen
                return None, last[:160]
        if i == 0 and len(candidates) > 1:
            print("   .. gekopieerde host verbond niet; ik zoek de juiste regio-host...")
    return None, last[:160]


def vraag_dburl() -> None:
    while True:
        input(
            "\n> In Supabase: klik 'Connect' (bovenin) -> 'Connection String' -> type URI ->\n"
            "  kies SESSION POOLER (host bevat 'pooler'), kopieer de regel, druk Enter... "
        )
        v = "".join(pbpaste().split())
        if not re.match(r"^postgres(ql)?://\S+@\S+:\d{4,5}/postgres$", v):
            print("   x dat lijkt geen connection string — kopieer de hele URI-regel.")
            continue
        if "pooler" not in v:
            print("   x dit is de Direct connection (IPv6-only). Kies de SESSION POOLER-variant.")
            continue
        if "[YOUR-PASSWORD]" in v:
            pw = getpass.getpass("   Typ je database-wachtwoord (onzichtbaar): ").strip()
            if not pw or any(c in pw for c in "@:/#?[]"):
                print("   x leeg of bevat @:/#?[] — reset het wachtwoord naar alleen letters+cijfers.")
                continue
            v = v.replace("[YOUR-PASSWORD]", pw)
        print("   .. verbinding testen...")
        working, err = probe(v)
        if working is None:
            print(f"   x verbinding mislukt: {err}")
            print("     (wachtwoord fout? reset in Supabase. Of gebruik de SQL Editor — zie chat.)")
            again = input("     opnieuw proberen? [j/N] ").strip().lower()
            if again != "j":
                return
            continue
        set_env("SUPABASE_DB_URL", working)
        print("   ok SUPABASE_DB_URL gezet en VERBINDING GETEST — werkt!")
        return


def main() -> None:
    if not ENV.exists():
        print(f"x {ENV} bestaat niet."); sys.exit(1)
    only_db = len(sys.argv) > 1 and sys.argv[1] == "db"
    if not only_db:
        vraag_jwt("anon / public key", "SUPABASE_ANON_KEY", "anon")
        vraag_jwt("service_role / secret key", "SUPABASE_SERVICE_ROLE_KEY", "service_role")
    vraag_dburl()
    print("\nKlaar. Zeg in de chat 'done' — dan pas ik de migraties toe.")


if __name__ == "__main__":
    main()
