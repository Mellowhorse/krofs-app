import "server-only";
import {
  createSendGuard,
  loadSendGuardConfig,
  SendBlockedError,
} from "./sendGuard";

// WhatsApp sender. Provider-agnostic surface; Meta Cloud API implementation.
//
//   SEND_MODE=sandbox (default)  -> DRY-RUN: nothing is actually sent, a
//     simulated id is returned. Safe by construction (no message leaves), so
//     the whole outbox/sweep can be exercised without any provider account.
//   SEND_MODE=live               -> real Meta Cloud API call, gated by the
//     send-guard (TEST_ALLOWLIST + LIVE_CONFIRM). Requires META_* env.
//
// (A future "twilio-sandbox" mode would sit between these — real sends, but
//  only to numbers that joined the sandbox; the guard already models that.)

const GRAPH = "https://graph.facebook.com/v21.0";

export type SendResult =
  | { ok: true; providerId: string; simulated: boolean }
  | { ok: false; error: string; blocked?: boolean };

export function newSender() {
  const guard = createSendGuard(loadSendGuardConfig(process.env));
  return guard;
}

export async function sendInvite(
  guard: ReturnType<typeof newSender>,
  opts: { to: string; firstName: string; link: string; kind: "invite" | "reminder" },
): Promise<SendResult> {
  if (guard.mode !== "live") {
    // dry-run — no provider call, nothing leaves the machine.
    guard.markSent();
    return {
      ok: true,
      simulated: true,
      providerId: `sandbox-${Math.random().toString(36).slice(2, 12)}`,
    };
  }

  try {
    guard.assertAllowed(opts.to);
  } catch (e) {
    if (e instanceof SendBlockedError) return { ok: false, error: e.message, blocked: true };
    throw e;
  }

  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!phoneId || !token) {
    return { ok: false, error: "META_PHONE_NUMBER_ID / META_ACCESS_TOKEN ontbreken" };
  }
  const templateName =
    opts.kind === "reminder"
      ? process.env.META_TEMPLATE_REMINDER || "krofs_herinnering"
      : process.env.META_TEMPLATE_INVITE || "krofs_uitnodiging";

  const body = {
    messaging_product: "whatsapp",
    to: opts.to.replace(/^\+/, ""),
    type: "template",
    template: {
      name: templateName,
      language: { code: "nl" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: opts.firstName },
            { type: "text", text: opts.link },
          ],
        },
      ],
    },
  };

  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: json?.error?.message || `Meta HTTP ${res.status}` };
  }
  guard.markSent();
  return {
    ok: true,
    simulated: false,
    providerId: json?.messages?.[0]?.id ?? "unknown",
  };
}
