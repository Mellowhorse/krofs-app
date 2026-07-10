import { getInviteByToken } from "@/lib/supabaseAdmin";
import PainterForm from "./PainterForm";

export const dynamic = "force-dynamic";

function ClosedPage() {
  // ONE opaque page for every failure (used / expired / unknown / opted-out) so
  // the token is not turned into a state/timing oracle.
  return (
    <div className="wrap">
      <div className="card">
        <div className="body done">
          <div className="check" aria-hidden>
            &#10003;
          </div>
          <h2>Bedankt!</h2>
          <p>
            Je gegevens zijn al ontvangen, of deze link is niet meer geldig. Neem
            contact op met Ruben als dit niet klopt.
          </p>
        </div>
      </div>
    </div>
  );
}

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await getInviteByToken(token);

  if (!invite.ok) {
    return <ClosedPage />;
  }

  return <PainterForm token={token} invite={invite} />;
}
