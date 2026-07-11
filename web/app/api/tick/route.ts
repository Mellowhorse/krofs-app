import { NextResponse } from "next/server";
import { runTick } from "@/lib/sweeps";

export const dynamic = "force-dynamic";

// External scheduler (Cloudflare Workers Cron, */15) POSTs here with the shared
// secret. Runs the due sweeps: dispatch pending invites, send 24h reminders,
// close rounds past their deadline. Idempotent — safe to call repeatedly.
export async function POST(req: Request) {
  const secret = process.env.CRON_SWEEP_SECRET;
  const given = req.headers.get("x-cron-secret");
  if (!secret || given !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await runTick();
  return NextResponse.json({ ok: true, ...result });
}

export function GET() {
  return NextResponse.json({ ok: false, error: "POST only" }, { status: 405 });
}
