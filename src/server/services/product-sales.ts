import { and, eq, inArray, isNull, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  bales,
  batches,
  counterparties,
  ledgerAccounts,
  ledgerEntries,
  ledgerTx,
  productSales,
  runOutputs,
  saleBales,
  saleReceipts,
} from "@/db/schema/index";
import { DomainError, diramToSomoniString, gramsToKgString } from "@/domain/units";
import { buildProductSaleCreditTx, buildSaleReceiptTx } from "@/domain/ledger";
import { bulkNetG, isBulk, saleAmountD, type ProductKind } from "@/domain/product";
import { tgProduct } from "@/lib/i18n/products";
import {
  buyerReceivableAccountIdFor,
  primaryCashAccountId,
  productRevenueAccountId,
} from "./balances";
import { resolveProductPriceAt } from "./product-pricing";
import { derivedUuid } from "./derived-uuid";

/**
 * Фурӯши маҳсулот — selling what the gin produced. docs/domain.md §7.
 *
 * Two shapes, and the difference is physical rather than clerical:
 *
 *  - **Bulk** (чигит, улюк, пучоқ) leaves as a heap on a lorry. The lorry arrives empty,
 *    so тара is weighed first and брутто after loading — intake mirrored — and the sale
 *    is брутто − тара at the owner's price.
 *  - **Кип** leaves as a stack of numbered objects. Each was weighed at the press and
 *    carries that weight for life, so the sale weighs nothing: it is the sum of the bales
 *    scanned onto the trailer. Weighing the trailer instead would produce a second,
 *    disagreeing figure for lint that a production run has already accounted for.
 *
 * Both post the same pair of transactions, and the money is the cashier's business from
 * that point on.
 */

type Executor = Pick<typeof db, "select" | "insert" | "update" | "execute">;

// ---------------------------------------------------------------- scanning

export interface ScannedBale {
  id: string;
  serial: string;
  weightG: number;
  batchNumber: number | null;
  state: string;
  /** Null when the bale may be loaded; otherwise why it may not. */
  refusal: string | null;
}

/**
 * What the loading bay learns when a barcode is scanned.
 *
 * Every answer is a row, including the refusals — a bale that is already on somebody
 * else's lorry has to come back as "already sold, invoice F-2026-000031", not as an empty
 * result that looks like a bad scan and gets tried three more times.
 */
export async function lookupBaleBySerial(serial: string): Promise<ScannedBale | null> {
  const [row] = await db
    .select({
      id: bales.id,
      serial: bales.serial,
      weightG: bales.weightG,
      state: bales.state,
      voidedAt: bales.voidedAt,
      batchNumber: batches.number,
      soldInvoice: raw<string | null>`(
        SELECT ps.invoice_no FROM sale_bales sb
          JOIN product_sales ps ON ps.id = sb.sale_id
         WHERE sb.bale_id = bales.id AND ps.reversed_at IS NULL
         LIMIT 1
      )`,
    })
    .from(bales)
    .leftJoin(batches, eq(batches.id, bales.batchId))
    .where(eq(bales.serial, serial.trim().toUpperCase()))
    .limit(1);

  if (!row) return null;

  let refusal: string | null = null;
  if (row.voidedAt) refusal = "Ин кип бекор карда шудааст.";
  else if (row.soldInvoice) refusal = `Аллакай фурӯхта шудааст — ҳисобнома ${row.soldInvoice}.`;
  else if (row.state !== "IN_STOCK") refusal = "Ин кип дар анбор нест.";

  return {
    id: row.id,
    serial: row.serial,
    weightG: row.weightG,
    batchNumber: row.batchNumber,
    state: row.state,
    refusal,
  };
}

// ---------------------------------------------------------------- selling

export interface SellProductInput {
  clientUuid: string;
  product: ProductKind;
  buyerId: string;
  /** Bulk only, grams. Брутто must exceed тара. */
  tareG?: number;
  grossG?: number;
  tareSource?: "manual" | "indicator";
  grossSource?: "manual" | "indicator";
  tareRaw?: string | null;
  grossRaw?: string | null;
  weighReason?: string | null;
  vehicleId?: string | null;
  /** Кип only: the bales scanned onto the lorry, in scan order. */
  baleIds?: string[];
  /** Cash handed over at the gate. Omit or 0 for a sale on credit. */
  paidNowD?: number;
  soldBy: string;
  stationId?: string | null;
  note?: string | null;
  soldAt?: Date;
}

export interface SoldProduct {
  saleId: string;
  invoiceNo: string;
  weightG: number;
  priceDPerKg: number;
  amountD: number;
  paidNowD: number;
  outstandingD: number;
  baleCount: number;
  replayed: boolean;
}

export async function sellProduct(input: SellProductInput): Promise<SoldProduct> {
  const soldAt = input.soldAt ?? new Date();
  const season = soldAt.getFullYear();

  const [seen] = await db
    .select()
    .from(productSales)
    .where(eq(productSales.clientUuid, input.clientUuid))
    .limit(1);
  if (seen) {
    const [count] = await db
      .select({ n: raw<string>`COUNT(*)` })
      .from(saleBales)
      .where(eq(saleBales.saleId, seen.id));
    return {
      saleId: seen.id,
      invoiceNo: seen.invoiceNo,
      weightG: seen.weightG,
      priceDPerKg: seen.priceDPerKg,
      amountD: seen.amountD,
      paidNowD: 0,
      outstandingD: 0,
      baleCount: Number(count?.n ?? 0),
      replayed: true,
    };
  }

  // The owner's price, as it stands at the moment of sale, frozen onto the row.
  const price = await resolveProductPriceAt(input.product, soldAt);

  return await db.transaction(async (tx) => {
    const [buyer] = await tx
      .select()
      .from(counterparties)
      .where(eq(counterparties.id, input.buyerId))
      .for("update")
      .limit(1);
    if (!buyer) throw new DomainError("Харидор ёфт нашуд. / No such buyer.");

    let weightG: number;
    let baleIds: string[] = [];

    if (isBulk(input.product)) {
      if (input.tareG === undefined || input.grossG === undefined) {
        throw new DomainError(
          "Тара ва брутто ҳатмист. / A bulk sale needs both тара and брутто.",
        );
      }
      weightG = bulkNetG(input.tareG, input.grossG);

      // A typed weight has to say why there was no indicator behind it — the same rule
      // the weighbridge applies on the way in.
      const typed =
        (input.tareSource ?? "manual") === "manual" ||
        (input.grossSource ?? "manual") === "manual";
      if (typed && !input.weighReason?.trim()) {
        throw new DomainError(
          "Вазни дастӣ бе сабаб қабул намешавад. / A hand-entered weight needs a reason.",
        );
      }
    } else {
      baleIds = [...new Set(input.baleIds ?? [])];
      if (baleIds.length === 0) {
        throw new DomainError(
          "Ягон кип сканер нашудааст. / No bales were scanned onto this lorry.",
        );
      }
      weightG = await claimBales(tx, baleIds);
    }

    const amountD = saleAmountD(weightG, price.priceDPerKg);
    if (amountD <= 0) {
      throw new DomainError("Маблағи фурӯш сифр аст. / The sale comes to nothing.");
    }

    const invoiceNo = await nextInvoiceNo(tx, season);

    const buyerReceivableAccountId = await buyerReceivableAccountIdFor(buyer.id, buyer.name, tx);
    const revenueAccountId = await productRevenueAccountId(tx);

    const memo =
      `Фурӯши ${tgProduct[input.product]} — ${buyer.name}, ` +
      `${gramsToKgString(weightG, 1)} кг`;

    const creditTxId = await postTx(tx, {
      clientUuid: derivedUuid(input.clientUuid, "sale-credit"),
      draft: buildProductSaleCreditTx(
        amountD,
        { buyerReceivableAccountId, productRevenueAccountId: revenueAccountId },
        memo,
      ),
      occurredAt: soldAt,
      createdBy: input.soldBy,
      stationId: input.stationId ?? null,
    });

    const [sale] = await tx
      .insert(productSales)
      .values({
        clientUuid: input.clientUuid,
        season,
        invoiceNo,
        product: input.product,
        buyerId: buyer.id,
        vehicleId: input.vehicleId ?? null,
        tareG: isBulk(input.product) ? (input.tareG ?? null) : null,
        grossG: isBulk(input.product) ? (input.grossG ?? null) : null,
        tareSource: input.tareSource ?? "manual",
        grossSource: input.grossSource ?? "manual",
        tareRaw: input.tareRaw ?? null,
        grossRaw: input.grossRaw ?? null,
        weighReason: input.weighReason?.trim() || null,
        weightG,
        priceDPerKg: price.priceDPerKg,
        amountD,
        paid: false,
        ledgerTxId: creditTxId,
        soldAt,
        soldBy: input.soldBy,
        note: input.note?.trim() || null,
      })
      .returning({ id: productSales.id });
    if (!sale) throw new Error("Could not record the sale.");

    if (baleIds.length > 0) {
      const rows = await tx
        .select({ id: bales.id, weightG: bales.weightG })
        .from(bales)
        .where(inArray(bales.id, baleIds));
      await tx.insert(saleBales).values(
        rows.map((b) => ({ saleId: sale.id, baleId: b.id, weightG: b.weightG, scannedAt: soldAt })),
      );
      // They have physically left the yard. SOLD waits for the money, which is what the
      // buyer's balance is for.
      await tx.update(bales).set({ state: "SHIPPED" }).where(inArray(bales.id, baleIds));
    }

    let paidNowD = 0;
    if (input.paidNowD && input.paidNowD > 0) {
      const received = await postReceipt(tx, {
        clientUuid: derivedUuid(input.clientUuid, "sale-receipt"),
        buyerId: buyer.id,
        buyerName: buyer.name,
        saleId: sale.id,
        amountD: input.paidNowD,
        receivedAt: soldAt,
        receivedBy: input.soldBy,
        stationId: input.stationId ?? null,
        note: null,
      });
      paidNowD = received.amountD;
      if (paidNowD >= amountD) {
        await tx.update(productSales).set({ paid: true }).where(eq(productSales.id, sale.id));
        if (baleIds.length > 0) {
          await tx.update(bales).set({ state: "SOLD" }).where(inArray(bales.id, baleIds));
        }
      }
    }

    await tx.insert(auditLog).values({
      action: "product.sell",
      entityTable: "product_sales",
      entityId: sale.id,
      payload: {
        invoiceNo, product: input.product, buyer: buyer.name,
        weightG, priceDPerKg: price.priceDPerKg, amountD, paidNowD, bales: baleIds.length,
      },
      actorId: input.soldBy,
      stationId: input.stationId ?? null,
      occurredAt: soldAt,
    });

    return {
      saleId: sale.id,
      invoiceNo,
      weightG,
      priceDPerKg: price.priceDPerKg,
      amountD,
      paidNowD,
      outstandingD: amountD - paidNowD,
      baleCount: baleIds.length,
      replayed: false,
    };
  });
}

/**
 * Locks the scanned bales, checks every one of them, and returns their total weight.
 *
 * Locked before they are checked, and checked inside the same transaction that sells
 * them: the unique index on `sale_bales.bale_id` is the real guarantee that a bale cannot
 * be in two sales, but reaching that index with a lorry already loaded means telling the
 * driver to unload. This is where it is caught in time to say which bale.
 */
async function claimBales(x: Executor, baleIds: string[]): Promise<number> {
  const rows = await x
    .select({
      id: bales.id,
      serial: bales.serial,
      weightG: bales.weightG,
      state: bales.state,
      voidedAt: bales.voidedAt,
    })
    .from(bales)
    .where(inArray(bales.id, baleIds))
    .for("update");

  if (rows.length !== baleIds.length) {
    throw new DomainError("Баъзе кипҳо ёфт нашуданд. / Some scanned bales are not on file.");
  }

  const alreadySold = await x
    .select({ baleId: saleBales.baleId })
    .from(saleBales)
    .where(inArray(saleBales.baleId, baleIds));
  if (alreadySold.length > 0) {
    const sold = new Set(alreadySold.map((r) => r.baleId));
    const serials = rows.filter((r) => sold.has(r.id)).map((r) => r.serial);
    throw new DomainError(
      `Ин кипҳо аллакай фурӯхта шудаанд: ${serials.join(", ")}. / Already sold.`,
    );
  }

  const unavailable = rows.filter((r) => r.voidedAt || r.state !== "IN_STOCK");
  if (unavailable.length > 0) {
    throw new DomainError(
      `Ин кипҳо дар анбор нестанд: ${unavailable.map((r) => r.serial).join(", ")}. / ` +
        `Not in stock.`,
    );
  }

  return rows.reduce((sum, r) => sum + r.weightG, 0);
}

// ---------------------------------------------------------------- receipts

export interface ReceiveSalePaymentInput {
  clientUuid: string;
  buyerId: string;
  amountD: number;
  receivedBy: string;
  stationId?: string | null;
  note?: string | null;
  receivedAt?: Date;
}

/**
 * The buyer comes in and pays, in whole or in part. Recorded at the cash desk, against
 * the buyer rather than against any one invoice — by the time a local settles up he has
 * usually taken three lorries.
 */
export async function receiveSalePayment(input: ReceiveSalePaymentInput) {
  const receivedAt = input.receivedAt ?? new Date();

  const [seen] = await db
    .select()
    .from(saleReceipts)
    .where(eq(saleReceipts.clientUuid, input.clientUuid))
    .limit(1);
  if (seen) {
    return {
      receiptId: seen.id,
      receiptNo: seen.receiptNo,
      amountD: seen.amountD,
      balanceAfterD: seen.balanceAfterD,
      replayed: true,
    };
  }

  return await db.transaction(async (tx) => {
    const [buyer] = await tx
      .select()
      .from(counterparties)
      .where(eq(counterparties.id, input.buyerId))
      .for("update")
      .limit(1);
    if (!buyer) throw new DomainError("Харидор ёфт нашуд. / No such buyer.");

    const posted = await postReceipt(tx, {
      clientUuid: input.clientUuid,
      buyerId: buyer.id,
      buyerName: buyer.name,
      saleId: null,
      amountD: input.amountD,
      receivedAt,
      receivedBy: input.receivedBy,
      stationId: input.stationId ?? null,
      note: input.note ?? null,
    });

    // Anything this buyer has taken and now fully paid for becomes SOLD; the bales stop
    // being "out on a lorry we have not been paid for".
    if (posted.balanceAfterD === 0) {
      await tx
        .update(productSales)
        .set({ paid: true })
        .where(and(eq(productSales.buyerId, buyer.id), eq(productSales.paid, false)));
      await tx.execute(raw`
        UPDATE bales SET state = 'SOLD'
         WHERE state = 'SHIPPED'
           AND id IN (SELECT sb.bale_id FROM sale_bales sb
                        JOIN product_sales ps ON ps.id = sb.sale_id
                       WHERE ps.buyer_id = ${buyer.id})
      `);
    }

    return {
      receiptId: posted.id,
      receiptNo: posted.receiptNo,
      amountD: posted.amountD,
      balanceAfterD: posted.balanceAfterD,
      replayed: false,
    };
  });
}

/** What one buyer owes us, read inside the transaction that is about to change it. */
export async function receivableInTx(x: Executor, buyerId: string): Promise<number> {
  const [row] = await x
    .select({ total: raw<string>`COALESCE(SUM(${ledgerEntries.amountD}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(
      and(
        eq(ledgerAccounts.kind, "BUYER_RECEIVABLE"),
        eq(ledgerAccounts.counterpartyId, buyerId),
      ),
    );
  return Math.max(0, Number(row?.total ?? 0));
}

async function postReceipt(
  x: Executor,
  args: {
    clientUuid: string;
    buyerId: string;
    buyerName: string;
    saleId: string | null;
    amountD: number;
    receivedAt: Date;
    receivedBy: string;
    stationId: string | null;
    note: string | null;
  },
): Promise<{ id: string; receiptNo: string; amountD: number; balanceAfterD: number }> {
  if (!Number.isSafeInteger(args.amountD) || args.amountD <= 0) {
    throw new DomainError("Маблағ бояд аз сифр зиёд бошад. / The amount must be positive.");
  }

  const owed = await receivableInTx(x, args.buyerId);
  if (args.amountD > owed) {
    throw new DomainError(
      `Ин харидор ҳамагӣ ${diramToSomoniString(owed)} сомонӣ қарздор аст. / ` +
        `This buyer owes only ${diramToSomoniString(owed)} сомонӣ.`,
    );
  }

  const cashAccountId = await primaryCashAccountId(x);
  const buyerReceivableAccountId = await buyerReceivableAccountIdFor(
    args.buyerId, args.buyerName, x,
  );

  const txId = await postTx(x, {
    clientUuid: args.clientUuid,
    draft: buildSaleReceiptTx(
      args.amountD,
      { cashAccountId, buyerReceivableAccountId },
      `Қабули пул аз ${args.buyerName}`,
    ),
    occurredAt: args.receivedAt,
    createdBy: args.receivedBy,
    stationId: args.stationId,
  });

  const balanceAfterD = owed - args.amountD;
  const receiptNo = await nextSaleReceiptNo(x, args.receivedAt.getFullYear());

  const [row] = await x
    .insert(saleReceipts)
    .values({
      clientUuid: args.clientUuid,
      buyerId: args.buyerId,
      saleId: args.saleId,
      amountD: args.amountD,
      balanceAfterD,
      receiptNo,
      ledgerTxId: txId,
      receivedAt: args.receivedAt,
      receivedBy: args.receivedBy,
      stationId: args.stationId,
      note: args.note,
    })
    .returning({ id: saleReceipts.id });
  if (!row) throw new Error("Could not record the receipt.");

  await x.insert(auditLog).values({
    action: "product.receipt",
    entityTable: "sale_receipts",
    entityId: row.id,
    payload: {
      buyer: args.buyerName, amountD: args.amountD, owedBefore: owed, balanceAfterD, receiptNo,
    },
    actorId: args.receivedBy,
    stationId: args.stationId,
    occurredAt: args.receivedAt,
  });

  return { id: row.id, receiptNo, amountD: args.amountD, balanceAfterD };
}

// ---------------------------------------------------------------- plumbing

async function postTx(
  x: Executor,
  args: {
    clientUuid: string;
    draft: ReturnType<typeof buildSaleReceiptTx>;
    occurredAt: Date;
    createdBy: string;
    stationId: string | null;
  },
): Promise<string> {
  const [row] = await x
    .insert(ledgerTx)
    .values({
      clientUuid: args.clientUuid,
      kind: args.draft.kind,
      occurredAt: args.occurredAt,
      memo: args.draft.memo,
      createdBy: args.createdBy,
      stationId: args.stationId,
    })
    .returning({ id: ledgerTx.id });
  if (!row) throw new Error("Could not post the ledger transaction.");

  await x.insert(ledgerEntries).values(
    args.draft.entries.map((e) => ({
      txId: row.id, accountId: e.accountId, amountD: e.amountD,
    })),
  );
  return row.id;
}

async function nextInvoiceNo(x: Executor, season: number): Promise<string> {
  await x.execute(raw`SELECT pg_advisory_xact_lock(hashtext('zarnishon:sale_invoice'))`);
  const [row] = await x
    .select({ n: raw<string>`COUNT(*)` })
    .from(productSales)
    .where(eq(productSales.season, season));
  return `F-${season}-${String(Number(row?.n ?? 0) + 1).padStart(6, "0")}`;
}

async function nextSaleReceiptNo(x: Executor, season: number): Promise<string> {
  await x.execute(raw`SELECT pg_advisory_xact_lock(hashtext('zarnishon:sale_receipt'))`);
  const [row] = await x
    .select({ n: raw<string>`COUNT(*)` })
    .from(saleReceipts)
    .where(raw`EXTRACT(YEAR FROM ${saleReceipts.receivedAt}) = ${season}`);
  return `QF-${season}-${String(Number(row?.n ?? 0) + 1).padStart(6, "0")}`;
}

/**
 * Маҳсулоти дар анбор — what the factory is holding of each product right now.
 *
 * For the three bulk products that is produced minus sold, both summed from their own
 * append-only tables. For кип it is neither: a bale is an object with a state, and stock
 * is simply the bales still standing in the shed — which is also the only figure that can
 * be checked by walking out and counting.
 */
export async function productStock(): Promise<
  Record<ProductKind, { weightG: number; count: number }>
> {
  const produced = await db
    .select({
      product: runOutputs.product,
      weightG: raw<string>`COALESCE(SUM(${runOutputs.weightG}), 0)`,
    })
    .from(runOutputs)
    .where(isNull(runOutputs.supersedesId))
    .groupBy(runOutputs.product);

  const sold = await db
    .select({
      product: productSales.product,
      weightG: raw<string>`COALESCE(SUM(${productSales.weightG}), 0)`,
    })
    .from(productSales)
    .where(isNull(productSales.reversedAt))
    .groupBy(productSales.product);

  const out: Record<ProductKind, { weightG: number; count: number }> = {
    chigit: { weightG: 0, count: 0 },
    kip: { weightG: 0, count: 0 },
    ulyuk: { weightG: 0, count: 0 },
    puchoq: { weightG: 0, count: 0 },
  };

  for (const r of produced) out[r.product as ProductKind].weightG += Number(r.weightG);
  for (const r of sold) {
    // Кип is counted from the bales themselves just below; subtracting sales here as well
    // would take the same lorry off the books twice.
    if (r.product === "kip") continue;
    out[r.product as ProductKind].weightG -= Number(r.weightG);
  }

  const [kip] = await db
    .select({
      count: raw<string>`COUNT(*)`,
      weightG: raw<string>`COALESCE(SUM(${bales.weightG}), 0)`,
    })
    .from(bales)
    .where(eq(bales.state, "IN_STOCK"));
  out.kip = { count: Number(kip?.count ?? 0), weightG: Number(kip?.weightG ?? 0) };

  return out;
}
