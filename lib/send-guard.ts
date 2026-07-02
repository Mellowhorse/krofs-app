/**
 * send-guard — the "no real sends in dev" guardrail (see CLAUDE.md rule 1).
 *
 * Every WhatsApp/SMS send MUST pass through a SendGuard. In sandbox mode (the
 * default) only numbers in TEST_ALLOWLIST can receive anything; real painter
 * numbers are blocked. Live mode additionally requires an explicit LIVE_CONFIRM
 * token, so you cannot go live by accident.
 *
 * Framework-agnostic: pass process.env (Node/Next) or Deno.env.toObject()
 * (Supabase Edge) to loadSendGuardConfig.
 *
 * Usage:
 *   const guard = createSendGuard(loadSendGuardConfig(process.env));
 *   guard.assertAllowed(toE164);   // throws SendBlockedError if not permitted
 *   await sendWhatsApp(...);
 *   guard.markSent();
 */

export type SendMode = "sandbox" | "live";

export const LIVE_CONFIRM_PHRASE = "I-UNDERSTAND-THIS-SENDS-REAL-WHATSAPP";

export class SendBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendBlockedError";
  }
}

export interface SendGuardConfig {
  mode: SendMode;
  allowlist: string[];
  maxPerRun: number;
  liveConfirmed: boolean;
}

type EnvLike = Record<string, string | undefined>;

function normalize(e164: string): string {
  return e164.replace(/[\s-]/g, "");
}

function redact(e164: string): string {
  const n = normalize(e164);
  return n.length <= 5 ? "***" : `${n.slice(0, 4)}***${n.slice(-2)}`;
}

export function loadSendGuardConfig(env: EnvLike): SendGuardConfig {
  const mode: SendMode = env.SEND_MODE === "live" ? "live" : "sandbox";
  const allowlist = (env.TEST_ALLOWLIST ?? "")
    .split(",")
    .map((s) => normalize(s))
    .filter((s) => s.length > 0);
  const maxPerRun = Number.parseInt(env.MAX_SENDS_PER_RUN ?? "50", 10) || 50;
  const liveConfirmed = env.LIVE_CONFIRM === LIVE_CONFIRM_PHRASE;
  return { mode, allowlist, maxPerRun, liveConfirmed };
}

export interface SendGuard {
  /** Throws SendBlockedError if a send to toE164 is not permitted right now. */
  assertAllowed(toE164: string): void;
  /** Record that a send happened, so the per-run cap is enforced. */
  markSent(): void;
  readonly sent: number;
  remaining(): number;
}

export function createSendGuard(cfg: SendGuardConfig): SendGuard {
  let sent = 0;
  return {
    assertAllowed(toE164: string): void {
      if (sent >= cfg.maxPerRun) {
        throw new SendBlockedError(
          `send cap reached: ${cfg.maxPerRun} sends this run`,
        );
      }
      if (cfg.mode === "live") {
        if (!cfg.liveConfirmed) {
          throw new SendBlockedError(
            "SEND_MODE=live but LIVE_CONFIRM is not set correctly — refusing to send",
          );
        }
        return;
      }
      if (!cfg.allowlist.includes(normalize(toE164))) {
        throw new SendBlockedError(
          `blocked: sandbox mode and ${redact(toE164)} is not in TEST_ALLOWLIST`,
        );
      }
    },
    markSent(): void {
      sent += 1;
    },
    get sent(): number {
      return sent;
    },
    remaining(): number {
      return Math.max(0, cfg.maxPerRun - sent);
    },
  };
}
