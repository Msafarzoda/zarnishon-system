import { redirect } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { priceQuotes, users, varieties } from "@/db/schema/index";
import { AuthError, requireRole } from "@/lib/auth/session";
import { diramToSomoniString } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { PriceForm } from "./price-form";

export const dynamic = "force-dynamic";

export default async function PricesPage() {
  let user;
  try {
    user = await requireRole("owner", "accountant");
  } catch (err) {
    if (err instanceof AuthError && err.code === "NOT_SIGNED_IN") redirect("/vorud");
    throw err;
  }

  const [quotes, varietyList] = await Promise.all([
    db
      .select({
        id: priceQuotes.id,
        priceDPerKg: priceQuotes.priceDPerKg,
        effectiveFrom: priceQuotes.effectiveFrom,
        note: priceQuotes.note,
        variety: varieties.code,
        setBy: users.fullName,
      })
      .from(priceQuotes)
      .leftJoin(varieties, eq(varieties.id, priceQuotes.varietyId))
      .leftJoin(users, eq(users.id, priceQuotes.setBy))
      .orderBy(desc(priceQuotes.effectiveFrom))
      .limit(50),
    db
      .select({ id: varieties.id, code: varieties.code })
      .from(varieties)
      .where(eq(varieties.isActive, true))
      .orderBy(asc(varieties.code)),
  ]);

  const current = quotes.find((q) => q.effectiveFrom <= new Date());

  return (
    <Shell user={user} title={tg.price.title}>
      <div className="space-y-5">
        <div className="card border-brand bg-brand-light px-4 py-4">
          <div className="text-sm text-brand-dark">{tg.price.current}</div>
          <div className="tabular text-3xl font-bold text-brand-dark">
            {current
              ? `${diramToSomoniString(current.priceDPerKg)} ${tg.price.perKg}`
              : "—"}
          </div>
          <p className="mt-2 text-sm text-brand-dark/80">{tg.price.paymentDayNotice}</p>
        </div>

        {user.role === "owner" ? (
          <PriceForm varieties={varietyList} />
        ) : (
          <p className="card px-4 py-3 text-sm text-ink-soft">{tg.price.onlyOwner}</p>
        )}

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink-soft">{tg.price.history}</h2>
          <table className="w-full text-sm">
            <thead className="text-ink-faint">
              <tr>
                <th className="py-1 text-start font-medium">{tg.price.effectiveFrom}</th>
                <th className="py-1 text-start font-medium">{tg.ticket.variety}</th>
                <th className="py-1 text-end font-medium">{tg.cash.price}</th>
                <th className="py-1 text-start font-medium ps-4">{tg.price.setBy}</th>
                <th className="py-1 text-start font-medium">{tg.price.note}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td className="py-2 tabular">
                    {q.effectiveFrom.toLocaleDateString("ru-RU")}
                  </td>
                  <td className="py-2">{q.variety ?? "—"}</td>
                  <td className="py-2 text-end tabular font-semibold">
                    {diramToSomoniString(q.priceDPerKg)}
                  </td>
                  <td className="py-2 ps-4 text-ink-soft">{q.setBy ?? "—"}</td>
                  <td className="py-2 text-ink-faint">{q.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </Shell>
  );
}
