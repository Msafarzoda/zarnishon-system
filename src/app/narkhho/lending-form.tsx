"use client";

import { useActionState, useMemo, useState } from "react";
import { collateralFor } from "@/domain/lending";
import { diramToSomoniString, gramsToKgString, somoniStringToDiram } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";
import { setLendingRateAction } from "./actions";

/** One farm's exposure, as the preview needs it. */
export interface LendingExposure {
  name: string;
  inHandG: number;
  outstandingD: number;
}

/**
 * Ҳадди қарз — the owner setting how much a kilogram of cotton in the shed is worth as
 * collateral.
 *
 * One number changes every farm's borrowing limit at once, so the panel computes the
 * consequence as it is typed: what the factory's total lending capacity becomes, and —
 * the part that matters — which farms would find themselves owing more than their cotton
 * now secures. That cannot be undone by the setting, because the money has already gone
 * out, and the owner should see it before saving rather than hear about it at the desk.
 *
 * The arithmetic is the same `collateralFor` the cash desk and the server both use.
 */
export function LendingForm({
  currentRateDPerKg, exposures,
}: {
  currentRateDPerKg: number;
  exposures: LendingExposure[];
}) {
  const [state, action, pending] = useActionState(
    setLendingRateAction,
    {} as { error?: string; ok?: string },
  );
  const [rate, setRate] = useState("");

  const proposed = useMemo(() => {
    if (!rate.trim()) return null;
    try {
      const d = somoniStringToDiram(rate);
      return d > 0 ? d : null;
    } catch {
      return null;
    }
  }, [rate]);

  const summary = useMemo(() => {
    const at = (r: number) =>
      exposures.reduce(
        (acc, e) => {
          const c = collateralFor({
            cottonInHandG: e.inHandG,
            outstandingAdvanceD: e.outstandingD,
            advanceRateDPerKg: r,
          });
          return {
            capacityD: acc.capacityD + c.maxAdvanceD,
            overLent: c.overLent ? [...acc.overLent, e.name] : acc.overLent,
          };
        },
        { capacityD: 0, overLent: [] as string[] },
      );

    const now = at(currentRateDPerKg);
    const after = proposed !== null ? at(proposed) : null;
    return {
      totalInHandG: exposures.reduce((n, e) => n + e.inHandG, 0),
      lentD: exposures.reduce((n, e) => n + e.outstandingD, 0),
      now,
      after,
      // Farms the change pushes over, as against those already over before it.
      newlyOverLent:
        after === null ? [] : after.overLent.filter((n) => !now.overLent.includes(n)),
    };
  }, [exposures, currentRateDPerKg, proposed]);

  return (
    <form action={action} className="card space-y-4 p-5">
      <div>
        <h2 className="font-semibold">{tg.lending.title}</h2>
        <p className="mt-0.5 text-sm text-ink-soft">{tg.lending.subtitle}</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="rounded-lg bg-paper px-4 py-3">
          <div className="text-xs text-ink-faint">{tg.lending.currentRate}</div>
          <div className="tabular text-2xl font-bold">
            {diramToSomoniString(currentRateDPerKg)} {tg.common.somoni}
          </div>
          <div className="text-xs text-ink-faint">{tg.lending.rate}</div>
        </div>

        <div className="min-w-40">
          <label className="label" htmlFor="rate">{tg.lending.newRate}</label>
          <input
            id="rate" name="rate" inputMode="decimal" required
            className="input-number text-2xl"
            placeholder={diramToSomoniString(currentRateDPerKg)}
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </div>

        <div className="min-w-48 flex-1">
          <label className="label" htmlFor="lend-reason">{tg.lending.reason}</label>
          <input id="lend-reason" name="reason" className="input" />
        </div>
      </div>

      {/* What one number does to everybody, before it is saved. */}
      {proposed !== null ? (
        <div className="space-y-3 rounded-lg border border-paper-line p-4">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <Figure
              label={tg.lending.example}
              value={`${tg.lending.exampleText} ${diramToSomoniString(proposed * 3000)} ${tg.common.somoni}`}
            />
            <Figure
              label={tg.lending.totalInHand}
              value={`${gramsToKgString(summary.totalInHandG, 0)} ${tg.common.kg}`}
            />
            <Figure
              label={tg.lending.capacityNow}
              value={`${diramToSomoniString(summary.now.capacityD)} ${tg.common.somoni}`}
            />
            <Figure
              label={tg.lending.capacityAfter}
              value={`${diramToSomoniString(summary.after?.capacityD ?? 0)} ${tg.common.somoni}`}
              tone={
                (summary.after?.capacityD ?? 0) < summary.now.capacityD ? "warn" : "brand"
              }
            />
            <Figure
              label={tg.lending.lentNow}
              value={`${diramToSomoniString(summary.lentD)} ${tg.common.somoni}`}
            />
          </div>

          {summary.newlyOverLent.length > 0 && (
            <div className="rounded-lg border border-warn bg-amber-50 p-3">
              <p className="text-sm font-medium text-warn">
                {tg.lending.willBeOverLent} — {summary.newlyOverLent.length}
              </p>
              <p className="mt-1 text-sm text-warn">{summary.newlyOverLent.join(" · ")}</p>
              <p className="mt-1 text-xs text-warn">{tg.lending.overLentWarning}</p>
            </div>
          )}

          {/* Farms already past their limit before this change — including loans made
              before there was a limit at all. The change did not cause it, but the owner
              looking at lending should not have to go somewhere else to learn it. */}
          {summary.now.overLent.length > 0 && (
            <div className="rounded-lg border border-paper-line bg-paper p-3">
              <p className="text-sm font-medium text-ink-soft">
                {tg.lending.alreadyOverLent} — {summary.now.overLent.length}
              </p>
              <p className="mt-1 text-sm text-ink-soft">{summary.now.overLent.join(" · ")}</p>
              <p className="mt-1 text-xs text-ink-faint">{tg.lending.alreadyOverLentHint}</p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-faint">{tg.lending.noChangeYet}</p>
      )}

      {state?.error && <p role="alert" className="text-sm text-alarm">{state.error}</p>}
      {state?.ok && <p role="status" className="text-sm text-brand">{state.ok}</p>}

      <button type="submit" disabled={pending || proposed === null} className="btn-primary">
        {pending ? tg.common.loading : tg.common.save}
      </button>
    </form>
  );
}

function Figure({
  label, value, tone,
}: { label: string; value: string; tone?: "brand" | "warn" }) {
  return (
    <div>
      <div className="text-xs text-ink-faint">{label}</div>
      <div
        className={`tabular font-semibold ${
          tone === "brand" ? "text-brand" : tone === "warn" ? "text-warn" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}
