import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Authenticated (per-user) server client. Uses the anon key + the user's session
// cookie, so all reads/writes go through RLS (is_admin_of). This is the admin
// path — distinct from lib/supabaseAdmin.ts (service_role, painter gateway only).
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // called from a Server Component — middleware refreshes the session
          }
        },
      },
    },
  );
}
