import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { stations } from "@/db/schema/index";
import { currentUser, homePathFor } from "@/lib/auth/session";
import { tg } from "@/lib/i18n/tg";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage() {
  const user = await currentUser();
  if (user) redirect(homePathFor(user.role));

  const rows = await db
    .select({ id: stations.id, code: stations.code, nameTg: stations.nameTg })
    .from(stations)
    .orderBy(asc(stations.code));

  return (
    <main className="min-h-screen grid place-items-center bg-paper px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-brand">{tg.app.name}</h1>
          <p className="mt-1 text-sm text-ink-soft">{tg.app.subtitle}</p>
        </div>
        <SignInForm stations={rows} />
      </div>
    </main>
  );
}
