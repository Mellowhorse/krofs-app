/**
 * Krofs scheduler — Cloudflare Worker (free tier).
 *
 * Calls the app's /api/tick every 15 minutes so reminders, dispatch and the
 * day-5 close run without pg_cron (works on Supabase Free; the DB-hitting
 * tick also keeps the Free project awake). Optionally pings Healthchecks.io
 * as a dead-man's-switch.
 *
 * Setup (dash.cloudflare.com, free account):
 *   1. Workers & Pages -> Create Worker -> paste this file -> Deploy.
 *   2. Worker -> Settings -> Variables and Secrets:
 *        TICK_URL     = https://<jouw-domein>/api/tick   (secret)
 *        CRON_SECRET  = <CRON_SWEEP_SECRET uit .env>     (secret)
 *        HEALTH_URL   = https://hc-ping.com/<uuid>       (optioneel)
 *   3. Worker -> Settings -> Triggers -> Cron Triggers -> add:  *\/15 * * * *
 */
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runTick(env));
  },
  // Manual trigger for testing: open the worker URL in a browser.
  async fetch(_req, env) {
    const result = await runTick(env);
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  },
};

async function runTick(env) {
  if (!env.TICK_URL || !env.CRON_SECRET) {
    return { ok: false, error: "TICK_URL / CRON_SECRET niet ingesteld" };
  }
  let tick;
  try {
    const res = await fetch(env.TICK_URL, {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET },
    });
    tick = { status: res.status, body: await res.text() };
  } catch (e) {
    tick = { status: 0, body: String(e) };
  }

  // Dead-man's-switch: only ping on a successful tick, so a broken app or
  // scheduler makes Healthchecks alert before the 7-day Supabase pause.
  if (env.HEALTH_URL && tick.status === 200) {
    try {
      await fetch(env.HEALTH_URL);
    } catch {
      /* best effort */
    }
  }
  return { ok: tick.status === 200, tick };
}
