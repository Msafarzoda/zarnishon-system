import { redirect } from "next/navigation";
import { currentUser, homeFor } from "@/lib/auth/session";

export default async function Home() {
  const user = await currentUser();
  redirect(user ? homeFor(user) : "/vorud");
}
