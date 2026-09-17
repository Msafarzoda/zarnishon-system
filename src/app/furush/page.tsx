import { asc, desc, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  counterparties,
  ledgerAccounts,
  ledgerEntries,
  productSales,
  users,
} from "@/db/schema/index";
import { canOperate, requirePageRole } from "@/lib/auth/session";
import { currentProductPrices } from "@/server/services/product-pricing";
import { productStock } from "@/server/services/product-sales";
import { cashOnHandD, totalBuyerReceivableD } from "@/server/services/balances";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { SalesClient } from "./sales-client";

export const dynamic = "force-dynamic";

/**
 * Фурӯш — selling what the gin produced. docs/domain.md §7.
 *
 * The screen the молшинос works from when a lorry turns up for a load of чигит, and the
 * screen the loading bay works from at the end of the season when the кип goes. Both are
 * the same transaction underneath; what differs is how the weight is arrived at, and the
 * screen asks for each in the way that product is actually measured.
 */
export default async function SalesPage() {
  const user = await requirePageRole(
    "merchandiser", "cashier", "owner", "accountant", "admin",
  );
  const readOnly = !canOperate(user, ["merchandiser"]);

  const [prices, stock, cash, owedToUs] = await Promise.all([
    currentProductPrices(),
    productStock(),
    cashOnHandD(),
    totalBuyerReceivableD(),
  ]);

  const buyers = await db
    .select({
      id: counterparties.id,
      name: counterparties.name,
      kind: counterparties.kind,
      tin: counterparties.tin,
      phone: counterparties.phone,
      owesD: raw<string>`COALESCE((
        SELECT SUM(e.amount_d) FROM ledger_entries e
        JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'BUYER_RECEIVABLE' AND a.counterparty_id = counterparties.id
      ), 0)`,
    })
    .from(counterparties)
    .where(eq(counterparties.isActive, true))
    .orderBy(asc(counterparties.name));

  const recent = await db
    .select({
      id: productSales.id,
      invoiceNo: productSales.invoiceNo,
      product: productSales.product,
      weightG: productSales.weightG,
      priceDPerKg: productSales.priceDPerKg,
      amountD: productSales.amountD,
      paid: productSales.paid,
      soldAt: productSales.soldAt,
      reversedAt: productSales.reversedAt,
      buyer: counterparties.name,
      seller: users.fullName,
      baleCount: raw<string>`(SELECT COUNT(*) FROM sale_bales sb WHERE sb.sale_id = product_sales.id)`,
    })
    .from(productSales)
    .innerJoin(counterparties, eq(counterparties.id, productSales.buyerId))
    .leftJoin(users, eq(users.id, productSales.soldBy))
    .orderBy(desc(productSales.soldAt))
    .limit(50);

  return (
    <Shell user={user} title={tg.sales.title}>
      {readOnly && <ReadOnlyBanner />}
      <SalesClient
        readOnly={readOnly}
        canReceive={canOperate(user, ["cashier"])}
        cashOnHandD={cash}
        owedToUsD={owedToUs}
        stock={stock}
        prices={Object.fromEntries(
          Object.entries(prices).map(([k, v]) => [k, v?.priceDPerKg ?? null]),
        ) as Record<string, number | null>}
        buyers={buyers.map((b) => ({
          id: b.id,
          name: b.name,
          kind: b.kind,
          tin: b.tin,
          phone: b.phone,
          owesD: Math.max(0, Number(b.owesD)),
        }))}
        recent={recent.map((r) => ({
          ...r,
          soldAt: r.soldAt.toISOString(),
          baleCount: Number(r.baleCount),
          reversed: r.reversedAt !== null,
        }))}
      />
    </Shell>
  );
}
