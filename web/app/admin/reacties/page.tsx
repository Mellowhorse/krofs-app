import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";
import GeocodeButton from "./GeocodeButton";

export const dynamic = "force-dynamic";

const WD = ["ma", "di", "wo", "do", "vr", "za", "zo"];

// yyyy-mm-dd -> "ma 27" (UTC-constructed so de datum niet verschuift)
function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WD[(dt.getUTCDay() + 6) % 7]} ${d}`;
}

function fmt(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
}

// PostgREST geeft een to-one embed soms als array terug
function one<T>(x: unknown): T | null {
  const v = Array.isArray(x) ? x[0] : x;
  return (v ?? null) as T | null;
}

type ResponseRow = {
  straat: string;
  huisnummer: string;
  postcode: string | null;
  plaats: string;
  geocode_status: string;
  response_workdays: Array<{ work_date: string }> | null;
};

type InviteRow = {
  painter_id: string;
  status: string;
  invite_responses: unknown;
};

export default async function ReactiesPage() {
  const supabase = await supabaseServer();

  // de lopende ronde; is er geen, dan de laatste (zodat je kunt terugkijken)
  const cols =
    "id, label, status, deadline_at, visit_week_start, visit_week_end, public_slug";
  const { data: lopend } = await supabase
    .from("weekrondes")
    .select(cols)
    .in("status", ["sending", "collecting"])
    .maybeSingle();
  const round =
    lopend ??
    (
      await supabase
        .from("weekrondes")
        .select(cols)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ).data;

  const crumb = (
    <p className="crumb">
      <Link href="/admin">Beheer</Link> / Reacties
    </p>
  );

  if (!round) {
    return (
      <div>
        {crumb}
        <h1>Wie heeft gereageerd?</h1>
        <p className="intro">
          Er is nog geen ronde. Start er een via <Link href="/admin/rondes">Rondes</Link>.
        </p>
      </div>
    );
  }

  const { data: roster } = await supabase
    .from("painters")
    .select("id, full_name, wa_phone_e164")
    .eq("is_active", true)
    .neq("wa_opt_in_status", "opted_out")
    .order("full_name");

  const { data: invites } = await supabase
    .from("round_invites")
    .select(
      "painter_id, status, invite_responses(straat, huisnummer, postcode, plaats, geocode_status, response_workdays(work_date))",
    )
    .eq("round_id", round.id);

  const byPainter = new Map<string, { status: string; resp: ResponseRow | null }>();
  for (const inv of (invites ?? []) as InviteRow[]) {
    byPainter.set(inv.painter_id, {
      status: inv.status,
      resp: one<ResponseRow>(inv.invite_responses),
    });
  }

  const base = process.env.PUBLIC_BASE_URL || "http://localhost:3100";
  const shareUrl = round.public_slug ? `${base}/u/${round.public_slug}` : null;

  const rosterList = roster ?? [];
  const beschikbaar: Array<{
    id: string;
    name: string;
    address: string;
    days: string[];
    geo: "ok" | "pending" | "check";
  }> = [];
  const nietAanHetWerk: Array<{ id: string; name: string }> = [];
  const geenReactie: Array<{ id: string; name: string; phone: string }> = [];

  for (const p of rosterList) {
    const hit = byPainter.get(p.id);
    if (hit?.status === "responded") {
      if (hit.resp) {
        const r = hit.resp;
        beschikbaar.push({
          id: p.id,
          name: p.full_name,
          address: `${r.straat} ${r.huisnummer}${r.postcode ? `, ${r.postcode}` : ""} ${r.plaats}`,
          days: (r.response_workdays ?? []).map((w) => w.work_date).sort().map(dayLabel),
          // 'pending' = nog niet gegeocodeerd (gaat vanzelf), geen probleem
          geo:
            r.geocode_status === "ok"
              ? "ok"
              : r.geocode_status === "pending"
                ? "pending"
                : "check",
        });
      } else {
        nietAanHetWerk.push({ id: p.id, name: p.full_name });
      }
    } else {
      geenReactie.push({ id: p.id, name: p.full_name, phone: p.wa_phone_e164 ?? "" });
    }
  }

  const reageerden = beschikbaar.length + nietAanHetWerk.length;
  const wachtOpAdres = beschikbaar.filter((p) => p.geo === "pending").length;

  return (
    <div>
      {crumb}
      <h1>Wie heeft gereageerd?</h1>
      <p className="intro">
        {round.label ?? "Ronde"} · {reageerden} van {rosterList.length} gereageerd ·
        deadline {fmt(round.deadline_at)} · bezoekweek {fmt(round.visit_week_start)}–
        {fmt(round.visit_week_end)}
      </p>

      {rosterList.length === 0 ? (
        <div className="roundcard">
          <p className="intro">
            Nog geen schilders in de lijst. Importeer ze eerst via{" "}
            <Link href="/admin/painters/import">Schilders importeren</Link>.
          </p>
        </div>
      ) : null}

      {wachtOpAdres > 0 ? (
        <GeocodeButton count={wachtOpAdres} />
      ) : null}

      {beschikbaar.length ? (
        <div className="reacties">
          <div className="reacties-kop">Beschikbaarheid doorgegeven ({beschikbaar.length})</div>
          {beschikbaar.map((p) => (
            <div className="reactierij" key={p.id}>
              <div className="reactierij-main">
                <div className="linkrow-name">
                  {p.name}
                  {p.geo === "check" ? (
                    <Link href="/admin/adressen" className="pill pill-invalid" style={{ marginLeft: 8 }}>
                      adres controleren
                    </Link>
                  ) : null}
                  {p.geo === "pending" ? (
                    <span className="pill pill-dup_db" style={{ marginLeft: 8 }}>
                      adres wordt opgezocht
                    </span>
                  ) : null}
                </div>
                <div className="muted" style={{ fontSize: 13 }}>{p.address}</div>
              </div>
              <div className="reactie-dagen">
                {p.days.length ? p.days.map((d) => (
                  <span className="dagpil" key={d}>{d}</span>
                )) : <span className="muted">geen dagen</span>}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {nietAanHetWerk.length ? (
        <div className="reacties">
          <div className="reacties-kop">Werkt deze week niet ({nietAanHetWerk.length})</div>
          {nietAanHetWerk.map((p) => (
            <div className="reactierij" key={p.id}>
              <div className="reactierij-main">
                <div className="linkrow-name">{p.name}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  Gaf aan deze week niet te werken
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {geenReactie.length ? (
        <div className="reacties">
          <div className="reacties-kop">Nog geen reactie ({geenReactie.length})</div>
          {geenReactie.map((p) => {
            const first = p.name.split(" ")[0];
            const msg =
              `Hoi ${first}, kleine herinnering van Kees (Krofs) — laat je even weten ` +
              `waar je werkt en op welke dagen? ${shareUrl ?? ""}`;
            const wa =
              p.phone && shareUrl
                ? `https://wa.me/${p.phone.replace(/^\+/, "")}?text=${encodeURIComponent(msg)}`
                : null;
            return (
              <div className="reactierij" key={p.id}>
                <div className="reactierij-main">
                  <div className="linkrow-name">{p.name}</div>
                  <div className="muted" style={{ fontSize: 13 }}>{p.phone || "geen nummer"}</div>
                </div>
                {wa ? (
                  <a className="btn-sm btn-wa" href={wa} target="_blank" rel="noreferrer">
                    Herinner
                  </a>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : rosterList.length ? (
        <p className="ok-msg" style={{ marginTop: 16 }}>Iedereen heeft gereageerd.</p>
      ) : null}
    </div>
  );
}
