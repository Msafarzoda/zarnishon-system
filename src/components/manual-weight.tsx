"use client";

import { useState } from "react";
import { DomainError, kgStringToGrams } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";

/**
 * Typing a weight by hand — the escape hatch, deliberately made awkward.
 *
 * The whole point of wiring the indicator in is that nobody types a weight. But an
 * indicator fails, a cable pulls out, and trucks keep arriving; refusing outright would
 * push the load onto paper, which is worse. So it stays possible and is made visible: it
 * demands a written reason, the weighing is stored as `source: "manual"`, and the owner
 * sees every one of them.
 */
export function ManualWeight({
  value,
  onChange,
  scaleAvailable,
}: {
  value: { weightG: number; reason: string } | null;
  onChange: (v: { weightG: number; reason: string } | null) => void;
  /** When the indicator is streaming there is no honest reason to type instead. */
  scaleAvailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kg, setKg] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-dashed border-paper-line px-3 py-2 text-sm text-ink-faint hover:border-warn hover:text-warn"
      >
        {tg.scale.manualEntry}
      </button>
    );
  }

  function apply(nextKg: string, nextReason: string) {
    setError(null);
    if (!nextKg.trim() || !nextReason.trim()) {
      onChange(null);
      return;
    }
    try {
      const weightG = kgStringToGrams(nextKg);
      if (weightG <= 0) {
        onChange(null);
        return;
      }
      onChange({ weightG, reason: nextReason.trim() });
    } catch (err) {
      onChange(null);
      setError(err instanceof DomainError ? err.message : tg.common.error);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-warn bg-amber-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-warn">{tg.scale.manualEntry}</p>
          <p className="text-sm text-warn/80">{tg.scale.manualWarning}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setKg("");
            setReason("");
            onChange(null);
          }}
          className="btn-secondary px-2 py-1 text-xs"
        >
          {tg.common.cancel}
        </button>
      </div>

      {scaleAvailable && (
        <p className="text-sm font-medium text-alarm">{tg.scale.readingFromScale}</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label text-warn" htmlFor="manual-kg">
            {tg.scale.enterWeight}
          </label>
          <input
            id="manual-kg" inputMode="decimal" autoComplete="off" className="input-number"
            placeholder="3015"
            value={kg}
            onChange={(e) => { setKg(e.target.value); apply(e.target.value, reason); }}
          />
        </div>
        <div>
          <label className="label text-warn" htmlFor="manual-reason">
            {tg.scale.manualReason}
          </label>
          <input
            id="manual-reason" className="input"
            value={reason}
            onChange={(e) => { setReason(e.target.value); apply(kg, e.target.value); }}
          />
        </div>
      </div>

      {error && <p className="text-sm text-alarm">{error}</p>}
      {value && (
        <p className="text-sm text-warn">
          {tg.ticket.net}: <strong className="tabular">{kg} {tg.common.kg}</strong>
        </p>
      )}
    </div>
  );
}
