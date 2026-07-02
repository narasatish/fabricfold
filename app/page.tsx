import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

export default async function Root() {
  const s = await getSession();
  if (s?.mode === "customer") redirect("/c");
  if (s?.mode === "staff") redirect("/s");
  redirect("/login");
}
