import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabaseServer";
import { signOut } from "../login/actions";
import Logo from "@/app/Logo";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: admin } = await supabase
    .from("app_admins")
    .select("org_id, display_name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!admin) {
    return (
      <div className="wrap">
        <div className="card" style={{ maxWidth: 420 }}>
          <div className="body">
            <h1>Geen toegang</h1>
            <p className="intro">
              Je bent ingelogd als {user.email}, maar dit account is geen
              beheerder. Neem contact op met de beheerder.
            </p>
            <form action={signOut}>
              <button className="btn btn-ghost" type="submit">
                Uitloggen
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="admin">
      <header className="adminbar">
        <div className="adminbrand">
          <Logo height={34} />
          <span className="sub">beheer</span>
        </div>
        <div className="adminbar-right">
          <span className="who">{admin.display_name ?? user.email}</span>
          <Link className="linkbtn" href="/admin/instellingen">
            Instellingen
          </Link>
          <form action={signOut}>
            <button className="linkbtn" type="submit">
              Uitloggen
            </button>
          </form>
        </div>
      </header>
      <main className="adminmain">{children}</main>
    </div>
  );
}
