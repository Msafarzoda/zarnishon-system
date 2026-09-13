import Link from "next/link";
import { currentUser, homePathFor } from "@/lib/auth/session";
import { tg } from "@/lib/i18n/tg";

export const dynamic = "force-dynamic";

/** Shown when a signed-in user opens a section their role does not cover. */
export default async function ForbiddenPage() {
  const user = await currentUser();
  const home = user ? homePathFor(user.role) : "/vorud";

  return (
    <main className="min-h-screen grid place-items-center bg-paper px-4">
      <div className="card max-w-sm p-8 text-center">
        <h1 className="text-lg font-semibold text-alarm">{tg.auth.noAccess}</h1>
        {user && (
          <p className="mt-2 text-sm text-ink-soft">
            {user.fullName} · {tg.roles[user.role]}
          </p>
        )}
        <Link href={home} className="btn-primary mt-6 w-full">
          {tg.common.back}
        </Link>
      </div>
    </main>
  );
}
