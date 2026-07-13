// Bootstrap the beheerder (Kees): create the auth user + seed app_admins.
// Run:  node --env-file=.env.local scripts/bootstrap-admin.mjs
// Optional env: ADMIN_EMAIL, ADMIN_PASSWORD, ORG_NAME
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { persistSession: false } });

const EMAIL = process.env.ADMIN_EMAIL || "kees@krofs.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "krofs-dev-1234";
const ORG_NAME = process.env.ORG_NAME || "Krofs";

async function main() {
  // 1. org
  let { data: orgs } = await admin
    .from("organizations")
    .select("id")
    .eq("name", ORG_NAME)
    .limit(1);
  let orgId = orgs?.[0]?.id;
  if (!orgId) {
    const { data, error } = await admin
      .from("organizations")
      .insert({ name: ORG_NAME })
      .select("id")
      .single();
    if (error) throw error;
    orgId = data.id;
  }

  // 2. auth user (idempotent)
  let userId;
  const { data: created, error: cuErr } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (cuErr) {
    if (/already|registered|exists/i.test(cuErr.message)) {
      const { data: list } = await admin.auth.admin.listUsers();
      userId = list.users.find((u) => u.email === EMAIL)?.id;
      if (!userId) throw new Error("user exists but not found in listUsers");
    } else {
      throw cuErr;
    }
  } else {
    userId = created.user.id;
  }

  // 3. app_admins
  const { error: aaErr } = await admin
    .from("app_admins")
    .upsert(
      { user_id: userId, org_id: orgId, display_name: "Kees" },
      { onConflict: "user_id" },
    );
  if (aaErr) throw aaErr;

  console.log("OK");
  console.log("  email:", EMAIL);
  console.log("  password:", PASSWORD);
  console.log("  org:", ORG_NAME, orgId);
  console.log("  user:", userId);
}

main().catch((e) => {
  console.error("bootstrap failed:", e.message || e);
  process.exit(1);
});
