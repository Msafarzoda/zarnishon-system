import { redirect } from "next/navigation";
import { signOut } from "@/lib/auth/session";
import { tg } from "@/lib/i18n/tg";

export function SignOutButton() {
  async function action() {
    "use server";
    await signOut();
    redirect("/vorud");
  }
  return (
    <form action={action}>
      <button type="submit" className="rounded px-2 py-1 text-white/80 hover:bg-white/15">
        {tg.auth.signOut}
      </button>
    </form>
  );
}
