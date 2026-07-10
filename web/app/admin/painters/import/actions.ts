"use server";

import { supabaseServer } from "@/lib/supabaseServer";
import { normalizeNLPhone } from "@/lib/phone";

export type RowStatus = "ok" | "invalid" | "dup_csv" | "dup_db";
export type PreviewRow = {
  line: number;
  naam: string;
  ruw: string;
  e164?: string;
  status: RowStatus;
  reason?: string;
};
export type PreviewResult = {
  ok: boolean;
  rows: PreviewRow[];
  okCount: number;
  error?: string;
};

function splitCells(line: string): string[] {
  const delim = line.includes(";") ? ";" : line.includes("\t") ? "\t" : ",";
  return line.split(delim).map((c) => c.trim());
}

async function adminCtx() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: admin } = await supabase
    .from("app_admins")
    .select("org_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!admin) return null;
  return { supabase, orgId: admin.org_id as string };
}

function classify(csvText: string, existing: Set<string>): PreviewRow[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rows: PreviewRow[] = [];
  const seen = new Set<string>();

  lines.forEach((line, i) => {
    const cells = splitCells(line);
    const naam = cells[0] ?? "";
    const ruw = cells[1] ?? "";
    // skip a header row (first line, looks like labels, phone doesn't normalize)
    if (
      i === 0 &&
      /naam|name|telefoon|phone|nummer|mobiel/i.test(line) &&
      !normalizeNLPhone(ruw).ok
    ) {
      return;
    }
    if (!naam && !ruw) return;

    if (!naam) {
      rows.push({ line: i + 1, naam, ruw, status: "invalid", reason: "naam ontbreekt" });
      return;
    }
    const norm = normalizeNLPhone(ruw);
    if (!norm.ok) {
      rows.push({ line: i + 1, naam, ruw, status: "invalid", reason: norm.reason });
      return;
    }
    if (existing.has(norm.e164)) {
      rows.push({ line: i + 1, naam, ruw, e164: norm.e164, status: "dup_db", reason: "bestaat al" });
      return;
    }
    if (seen.has(norm.e164)) {
      rows.push({ line: i + 1, naam, ruw, e164: norm.e164, status: "dup_csv", reason: "dubbel in lijst" });
      return;
    }
    seen.add(norm.e164);
    rows.push({ line: i + 1, naam, ruw, e164: norm.e164, status: "ok" });
  });
  return rows;
}

async function existingPhones(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  orgId: string,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("painters")
    .select("wa_phone_e164")
    .eq("org_id", orgId);
  return new Set(
    (data ?? [])
      .map((p: { wa_phone_e164: string | null }) => p.wa_phone_e164)
      .filter((x): x is string => !!x),
  );
}

export async function previewImport(csvText: string): Promise<PreviewResult> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, rows: [], okCount: 0, error: "geen toegang" };
  const existing = await existingPhones(ctx.supabase, ctx.orgId);
  const rows = classify(csvText, existing);
  return { ok: true, rows, okCount: rows.filter((r) => r.status === "ok").length };
}

export async function commitImport(
  csvText: string,
): Promise<{ ok: boolean; inserted: number; error?: string }> {
  const ctx = await adminCtx();
  if (!ctx) return { ok: false, inserted: 0, error: "geen toegang" };
  const { supabase, orgId } = ctx;

  // Re-classify server-side: never trust client-computed rows.
  const existing = await existingPhones(supabase, orgId);
  const valid = classify(csvText, existing).filter((r) => r.status === "ok");
  if (valid.length === 0) return { ok: true, inserted: 0 };

  const now = new Date().toISOString();
  const painterRows = valid.map((v) => ({
    org_id: orgId,
    full_name: v.naam,
    wa_phone_e164: v.e164!,
    wa_opt_in_status: "opted_in" as const,
    wa_opt_in_at: now,
    consent_source: "admin_import",
  }));

  const { data: inserted, error } = await supabase
    .from("painters")
    .insert(painterRows)
    .select("id");
  if (error) return { ok: false, inserted: 0, error: error.message };

  const consentRows = (inserted ?? []).map((p: { id: string }) => ({
    painter_id: p.id,
    org_id: orgId,
    event: "opt_in" as const,
    source: "admin_import",
  }));
  if (consentRows.length > 0) {
    await supabase.from("painter_consent_events").insert(consentRows);
  }

  return { ok: true, inserted: inserted?.length ?? 0 };
}
