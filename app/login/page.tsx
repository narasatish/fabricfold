import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import LoginForm from "./_components/LoginForm";

// A logged-in user hitting /login (e.g. via "Open app" on the marketing site)
// is sent straight to their app instead of seeing the login form again.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const s = await getSession();
  if (s?.mode === "customer") redirect("/c");
  if (s?.mode === "staff") redirect("/s");
  return <LoginForm />;
}
