// The no-real-sends guardrail for the web app (mirror of ../../lib/send-guard.ts).
// Sandbox by default: only TEST_ALLOWLIST numbers can receive; live mode needs
// an explicit LIVE_CONFIRM token; a per-run cap backstops both.

export const LIVE_CONFIRM_PHRASE = "I-UNDERSTAND-THIS-SENDS-REAL-WHATSAPP";

export class SendBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendBlockedError";
  }
}

export type SendMode = "sandbox" | "live";

function normalize(e164: string): string {
  return e164.replace(/[\s-]/g, "");
}
function redact(e164: string): string {
  const n = normalize(e164);
  return n.length <= 5 ? "***" : `${n.slice(0, 4)}***${n.slice(-2)}`;
}

type EnvLike = Record<string, string | undefined>;

export function loadSendGuardConfig(env: EnvLike) {
  const mode: SendMode = env.SEND_MODE === "live" ? "live" : "sandbox";
  const allowlist = (env.TEST_ALLOWLIST ?? "")
    .split(",")
    .map((s) => normalize(s))
    .filter((s) => s.length > 0);
  const maxPerRun = Number.parseInt(env.MAX_SENDS_PER_RUN ?? "50", 10) || 50;
  const liveConfirmed = env.LIVE_CONFIRM === LIVE_CONFIRM_PHRASE;
  return { mode, allowlist, maxPerRun, liveConfirmed };
}

export function createSendGuard(cfg: ReturnType<typeof loadSendGuardConfig>) {
  let sent = 0;
  return {
    get mode() {
      return cfg.mode;
    },
    assertAllowed(toE164: string): void {
      if (sent >= cfg.maxPerRun) {
        throw new SendBlockedError(`send cap reached: ${cfg.maxPerRun} sends this run`);
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
    get sent() {
      return sent;
    },
  };
}
