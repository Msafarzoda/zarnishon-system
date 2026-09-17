"use client";

import { useActionState, useState } from "react";
import { diramToSomoniString, gramsToKgString, somoniStringToDiram } from "@/domain/units";
import { saleAmountD, PRODUCT_KINDS, type ProductKind } from "@/domain/product";
import { tgProduct, tgProductHint } from "@/lib/i18n/products";
import { tg } from "@/lib/i18n/tg";
import { setProductPriceAction } from "./actions";

export interface ProductPriceRow {
  product: ProductKind;
  priceDPerKg: number | null;
  effectiveFrom: string | null;
  /** What is standing in the yard, so the owner prices against a real quantity. */
  stockG: number;
  stockCount: number;
}

/**
 * Нархи маҳсулот — the owner pricing what the factory sells.
 *
 * Four prices rather than one, and each shown beside the stock it applies to, because
 * these are set with a quantity in mind: "the кип is 1 900 bales, so a сомонӣ on the
 * price is …". The panel does that multiplication as the number is typed, which is the
 * question actually being asked and the one thing a price list on its own cannot answer.
 */
export function ProductPriceForm({ rows }: { rows: ProductPriceRow[] }) {
  const [state, action, pending] = useActionState(
    setProductPriceAction,
    {} as { error?: string; ok?: string },
  );
  const [product, setProduct] = useState<ProductKind>("chigit");
  const [price, setPrice] = useState("");

  const row = rows.find((r) => r.product === product);
  let proposedD: number | null = null;
  try {
    const d = price.trim() ? somoniStringToDiram(price) : 0;
    proposedD = d > 0 ? d : null;
  } catch {
    proposedD = null;
  }
  const wholeStockD =
    row && proposedD !== null ? saleAmountD(Math.max(0, row.stockG), proposedD) : null;

  return (
    <section className="card p-4 sm:p-5">
      <h2 className="mb-1 text-sm font-semibold text-ink-soft">{tg.sales.setPrices}</h2>
      <p className="mb-4 text-xs text-ink-faint">{tg.sales.subtitle}</p>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {PRODUCT_KINDS.map((p) => {
          const r = rows.find((x) => x.product === p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => setProduct(p)}
              className={`card px-3 py-2 text-start ${
                product === p ? "border-brand bg-brand-light" : "hover:bg-paper"
              }`}
            >
              <div className="font-semibold">{tgProduct[p]}</div>
              <div className="text-[11px] text-ink-faint">{tgProductHint[p]}</div>
              <div className="mt-1 tabular font-bold">
                {r?.priceDPerKg != null
                  ? `${diramToSomoniString(r.priceDPerKg)} ${tg.common.somoni}`
                  : <span className="text-sm font-medium text-warn">{tg.sales.noPriceYet}</span>}
              </div>
              <div className="tabular text-[11px] text-ink-soft">
                {tg.sales.stock}:{" "}
                {p === "kip"
                  ? `${r?.stockCount ?? 0} × ${tgProduct.kip}`
                  : `${gramsToKgString(Math.max(0, r?.stockG ?? 0), 0)} ${tg.common.kg}`}
              </div>
            </button>
          );
        })}
      </div>

      <form action={action} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
        <input type="hidden" name="product" value={product} />
        <label className="block">
          <span className="label">
            {tgProduct[product]} — {tg.sales.price}
          </span>
          <input
            name="price"
            className="input tabular text-xl"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder={row?.priceDPerKg != null ? diramToSomoniString(row.priceDPerKg) : "0.00"}
          />
        </label>
        <label className="block">
          <span className="label">{tg.price.note}</span>
          <input name="note" className="input" />
        </label>
        <button type="submit" className="btn-primary" disabled={pending || !price.trim()}>
          {tg.common.save}
        </button>
      </form>

      {/* What the price does to the whole yard. The reason the owner is standing here. */}
      {wholeStockD !== null && row && (
        <p className="mt-3 text-sm text-ink-soft">
          {tg.sales.stock} × {tg.sales.price} ={" "}
          <strong className="tabular text-ink">
            {diramToSomoniString(wholeStockD)} {tg.common.somoni}
          </strong>
        </p>
      )}

      {state.error && <p className="mt-3 text-sm text-alarm">{state.error}</p>}
      {state.ok && <p className="mt-3 text-sm text-brand-dark">{state.ok}</p>}
    </section>
  );
}
