"use server";

import { submitResponse, type SubmitArgs } from "@/lib/supabaseAdmin";

export async function submitAction(
  args: SubmitArgs,
): Promise<{ ok: boolean; reason?: string }> {
  // The token is the sole credential; all validation happens server-side in the
  // submit_response RPC (fail-closed, single-use, in-window). This action is a
  // thin pass-through that keeps the service_role key on the server.
  return submitResponse(args);
}
