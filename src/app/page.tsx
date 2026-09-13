import { redirect } from "next/navigation";
import { currentUser, homePathFor } from "@/lib/auth/session";

export default async function Home() {
  const user = await currentUser();
  redirect(user ? homePathFor(user.role) : "/vorud");
}
