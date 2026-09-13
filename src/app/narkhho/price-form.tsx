"use client";

import { useActionState } from "react";
import { tg } from "@/lib/i18n/tg";
import { setPriceAction } from "./actions";

export function PriceForm({ varieties }: { varieties: { id: string; code: string }[] }) {
  const [state, action, pending] = useActionState(
    setPriceAction,
    {} as { error?: string; ok?: string },
  );

  return (
    <form action={action} className="card p-5 space-y-4">
      <h2 className="font-semibold">{tg.price.title}</h2>

      <div className="grid gap-4 sm:grid-cols-4">
        <div>
          <label className="label" htmlFor="price">{tg.cash.price}</label>
          <input id="price" name="price" inputMode="decimal" required
                 className="input-number" placeholder="12.50" />
        </div>
        <div>
          <label className="label" htmlFor="varietyId">{tg.ticket.variety}</label>
          <select id="varietyId" name="varietyId" className="input" defaultValue="">
            <option value="">{tg.common.total}</option>
            {varieties.map((v) => <option key={v.id} value={v.id}>{v.code}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="effectiveFrom">{tg.price.effectiveFrom}</label>
          <input id="effectiveFrom" name="effectiveFrom" type="date" className="input"
                 defaultValue={new Date().toISOString().slice(0, 10)} />
        </div>
        <div>
          <label className="label" htmlFor="note">{tg.price.note}</label>
          <input id="note" name="note" className="input" />
        </div>
      </div>

      {state?.error && <p role="alert" className="text-sm text-alarm">{state.error}</p>}
      {state?.ok && <p role="status" className="text-sm text-brand">{state.ok}</p>}

      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? tg.common.loading : tg.common.save}
      </button>
    </form>
  );
}
