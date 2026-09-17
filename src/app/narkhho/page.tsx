import { asc, desc, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  counterparties,
  factorySettings,
  priceQuotes,
  users,
  varieties,
} from "@/db/schema/index";
import { canOperate, requirePageRole } from "@/lib/auth/session";
import { diramToSomoniString } from "@/domain/units";
import { getActiveSettings } from "@/server/services/settings";
import { tg } from "@/lib/i18n/tg";
import { tgProduct } from "@/lib/i18n/products";
import { Shell } from "@/components/shell";
import { currentProductPrices } from "@/server/services/product-pricing";
import { productStock } from "@/server/services/product-sales";
import { PRODUCT_KINDS, type ProductKind } from "@/domain/product";
import { PriceForm } from "./price-form";
import { ProductPriceForm, type ProductPriceRow } from "./product-price-form";
import { LendingForm, type LendingExposure } from "./lending-form";

export const dynamic = "force-dynamic";

export default async function PricesPage() {
  const user = await requirePageRole("owner", "accountant");

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

  const settings = await getActiveSettings();

  /**
   * Every farm's exposure, so the owner can see what moving the rate does before moving
   * it. Cotton "in hand" is the same definition the cash desk lends against: weighed or
   * analysed, not yet settled. docs/domain.md §4.
   *
   * Tables are named explicitly inside the subqueries — interpolating a Drizzle column
   * into a raw template renders it unqualified and collides with the join.
   */
  const exposureRows = await db
    .select({
      name: counterparties.name,
      inHandG: raw<string>`COALESCE((
        SELECT SUM(t.net_g) FROM weigh_tickets t
        WHERE t.consignor_id = counterparties.id
          AND t.status IN ('WEIGHED', 'ANALYSED')
      ), 0)`,
      outstandingD: raw<string>`COALESCE((
        SELECT SUM(e.amount_d) FROM ledger_entries e
        JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'ADVANCE_RECEIVABLE' AND a.counterparty_id = counterparties.id
      ), 0)`,
    })
    .from(counterparties)
    .where(eq(counterparties.isActive, true));

  const exposures: LendingExposure[] = exposureRows
    .map((r) => ({
      name: r.name,
      inHandG: Number(r.inHandG),
      outstandingD: Math.max(0, Number(r.outstandingD)),
    }))
    // A farm with neither cotton nor a loan changes nothing whichever way the rate moves.
    .filter((e) => e.inHandG > 0 || e.outstandingD > 0);

  // Settings are append-only, so the history is simply the rows in order.
  const rateHistory = await db
    .select({
      id: factorySettings.id,
      rate: factorySettings.advanceRateDPerKg,
      effectiveFrom: factorySettings.effectiveFrom,
      reason: factorySettings.reason,
      setBy: users.fullName,
    })
    .from(factorySettings)
    .leftJoin(users, eq(users.id, factorySettings.setBy))
    .orderBy(desc(factorySettings.effectiveFrom))
    .limit(20);

  // §7: the four selling prices, each beside the stock it applies to.
  const [productPrices, stock] = await Promise.all([currentProductPrices(), productStock()]);
  const productRows: ProductPriceRow[] = PRODUCT_KINDS.map((product: ProductKind) => ({
    product,
    priceDPerKg: productPrices[product]?.priceDPerKg ?? null,
    effectiveFrom: productPrices[product]?.effectiveFrom.toISOString() ?? null,
    stockG: stock[product].weightG,
    stockCount: stock[product].count,
  }));

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

        {canOperate(user, ["owner"]) ? (
          <>
            <PriceForm varieties={varietyList} />
            <LendingForm
              currentRateDPerKg={settings.advanceRateDPerKg}
              exposures={exposures}
            />
            <ProductPriceForm rows={productRows} />
          </>
        ) : (
          <>
            <p className="card px-4 py-3 text-sm text-ink-soft">{tg.price.onlyOwner}</p>
            {/* The accountant reads the selling prices but does not set them either. */}
            <div className="card p-4">
              <h2 className="mb-3 text-sm font-semibold text-ink-soft">{tg.sales.setPrices}</h2>
              <ul className="flex flex-wrap gap-3">
                {productRows.map((r) => (
                  <li key={r.product} className="card px-3 py-2">
                    <div className="text-xs text-ink-soft">{tgProduct[r.product]}</div>
                    <div className="tabular text-lg font-bold">
                      {r.priceDPerKg != null
                        ? `${diramToSomoniString(r.priceDPerKg)} ${tg.common.somoni}`
                        : tg.sales.noPriceYet}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            {/* The accountant reads the rate but does not set it. */}
            <div className="card px-4 py-3">
              <div className="text-sm text-ink-soft">{tg.lending.title}</div>
              <div className="tabular text-2xl font-bold">
                {diramToSomoniString(settings.advanceRateDPerKg)} {tg.common.somoni}
                <span className="ms-2 text-sm font-normal text-ink-faint">
                  {tg.lending.rate}
                </span>
              </div>
            </div>
          </>
        )}

        {rateHistory.length > 1 && (
          <section className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink-soft">
              {tg.lending.title} — {tg.lending.history}
            </h2>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-paper-line">
                {rateHistory.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 tabular text-ink-faint">
                      {r.effectiveFrom.toLocaleDateString("ru-RU")}
                    </td>
                    <td className="py-1.5 tabular font-semibold">
                      {diramToSomoniString(r.rate)} {tg.common.somoni}
                    </td>
                    <td className="py-1.5 text-ink-soft">{r.reason ?? ""}</td>
                    <td className="py-1.5 text-end text-ink-faint">{r.setBy ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
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
