import { getRoundBySlug } from "@/lib/supabaseAdmin";
import PublicForm from "./PublicForm";

export const dynamic = "force-dynamic";

function ClosedPage() {
  return (
    <div className="wrap">
      <div className="card">
        <div className="body done">
          <div className="check" aria-hidden>
            &#10003;
          </div>
          <h2>Bedankt!</h2>
          <p>
            Deze uitvraag is gesloten of de link is niet meer geldig. Neem contact
            op met Kees als dit niet klopt.
          </p>
        </div>
      </div>
    </div>
  );
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const round = await getRoundBySlug(slug);

  if (!round.ok) {
    return <ClosedPage />;
  }

  return <PublicForm slug={slug} round={round} />;
}
