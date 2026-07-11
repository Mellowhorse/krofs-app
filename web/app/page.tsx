import { redirect } from "next/navigation";

// No public landing page — the root sends you to the admin login. Painters
// reach the app only via their personal /r/{token} link.
export default function Home() {
  redirect("/login");
}
