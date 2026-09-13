"use client";

import { useActionState, useState } from "react";
import { tg } from "@/lib/i18n/tg";
import { openBatchAction } from "./actions";

type State = { error?: string; ok?: string };

export function BatchForms({
  season, varieties, storages,
}: {
  season: number;
  varieties: { id: string; code: string }[];
  storages: { id: string; nameTg: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(openBatchAction, {} as State);

  return (
    <div className="space-y-3">
      <button className="btn-secondary" onClick={() => setOpen((v) => !v)}>
        {tg.common.add}: {tg.ticket.batch}
      </button>

      {open && (
        <form action={action} className="card p-5 space-y-4">
          <input type="hidden" name="season" value={season} />
          <div className="grid gap-4 sm:grid-cols-5">
            <div>
              <label className="label" htmlFor="number">{tg.lab.batchNo}</label>
              <input id="number" name="number" inputMode="numeric" required
                     className="input tabular" placeholder="101" />
            </div>
            <div>
              <label className="label" htmlFor="b-variety">{tg.ticket.variety}</label>
              <select id="b-variety" name="varietyId" className="input" defaultValue="">
                <option value="">—</option>
                {varieties.map((v) => <option key={v.id} value={v.id}>{v.code}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="b-grade">{tg.ticket.grade}</label>
              <input id="b-grade" name="grade" inputMode="numeric" className="input tabular"
                     placeholder="1" />
            </div>
            <div>
              <label className="label" htmlFor="b-class">{tg.ticket.cottonClass}</label>
              <input id="b-class" name="cottonClass" className="input" placeholder="1" />
            </div>
            <div>
              <label className="label" htmlFor="b-storage">{tg.lab.storage}</label>
              <select id="b-storage" name="storageLocationId" className="input" defaultValue="">
                <option value="">—</option>
                {storages.map((s) => <option key={s.id} value={s.id}>{s.nameTg}</option>)}
              </select>
            </div>
          </div>

          {state?.error && <p role="alert" className="text-sm text-alarm">{state.error}</p>}
          {state?.ok && <p role="status" className="text-sm text-brand">{state.ok}</p>}

          <button type="submit" disabled={pending} className="btn-primary">
            {pending ? tg.common.loading : tg.common.save}
          </button>
        </form>
      )}
    </div>
  );
}
