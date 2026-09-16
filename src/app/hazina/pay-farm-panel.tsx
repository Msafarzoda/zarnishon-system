"use client";

import { useEffect, useMemo, useState } from "react";
import {
  diramToSomoniString,
  gramsToKgString,
  somoniStringToDiram,
} from "@/domain/units";
import { submit } from "@/lib/offline/station-client";
import { tg } from "@/lib/i18n/tg";
import type { FarmRow } from "./cash-client";

interface PlannedTicket {
  ticketId: string;
  serial: string;
  netG: number;
  payableG: number;
  grossAmountD: number;
  advanceOffsetD: number;
  cashPayableD: number;
}

interface Plan {
  fromBalanceD: number;
  existingBalanceD: number;
  tickets: PlannedTicket[];
  grossAmountD: number;
  advanceOffsetD: number;
  cashPayableD: number;
  disburseD: number;
  remainderD: number;
  shortfallD: number;
  unpriced: string[];
}

/**
 * Пардохт ба хоҷагӣ — the farm asks for an amount, not for a борхат.
 *
 * «Ман 6 000 сомонӣ мехоҳам» is what actually gets said at the window, after four or five
 * deliveries and two months of waiting. So the cashier picks the farm, types the number,
 * and the system says which борхатҳо that reaches — oldest first, at today's price, with
 * the outstanding қарз coming off on the way. The plan is computed on the server by the
 * same code that will post it, so what is on the screen is what will be in the ledger.
 * docs/domain.md §4.
 */
export function PayFarmPanel({
  farm, cashOnHandD, onCancel, onNotice, onDone,
}: {
  farm: FarmRow;
  cashOnHandD: number;
  onCancel: () => void;
  onNotice: (n: { tone: "ok" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [everything, setEverything] = useState(false);
  const [copyCollected, setCopyCollected] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);

  const requestedCashD = useMemo(() => {
    if (everything) return null;
    if (!amount.trim()) return 0;
    try {
      return somoniStringToDiram(amount);
    } catch {
      return NaN;
    }
  }, [amount, everything]);

  const amountInvalid = typeof requestedCashD === "number" && Number.isNaN(requestedCashD);

  // Ask the server what this would settle, debounced so every keystroke is not a request.
  useEffect(() => {
    if (amountInvalid) { setPlan(null); return; }
    if (requestedCashD === 0) { setPlan(null); return; }

    let cancelled = false;
    setPlanning(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/farm-payments/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ counterpartyId: farm.id, requestedCashD }),
        });
        if (!res.ok) throw new Error(String(res.status));
        // The API returns the result itself, not an envelope around it.
        const body = (await res.json()) as Plan;
        if (!cancelled) setPlan(body);
      } catch {
        if (!cancelled) setPlan(null);
      } finally {
        if (!cancelled) setPlanning(false);
      }
    }, 300);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [farm.id, requestedCashD, amountInvalid]);

  const notEnoughCash = plan !== null && plan.disburseD > cashOnHandD;

  async function pay() {
    // A payment with no tickets is the ordinary case for a farm collecting money it is
    // already owed — what must not happen is a payment of nothing.
    if (!plan || plan.disburseD <= 0) return;
    setBusy(true);
    try {
      const res = await submit<{
        disbursedD: number; farmBalanceD: number; disbursementId: string | null;
        settled: { serial: string }[];
      }>("/api/farm-payments", {
        counterpartyId: farm.id,
        requestedCashD,
        copyCollected,
        paidAt: new Date().toISOString(),
      });

      if (res.kind === "rejected") {
        onNotice({ tone: "bad", text: res.message });
        return;
      }
      if (res.kind === "queued") {
        // Cash must never leave the drawer on an unconfirmed payment.
        onNotice({ tone: "bad", text: `${tg.app.offline} — ${tg.cash.confirmPay}` });
        return;
      }

      onNotice({
        tone: "ok",
        text:
          `${farm.name} — ${tg.cash.paidNow} ` +
          `${diramToSomoniString(res.result.disbursedD)} ${tg.common.somoni} · ` +
          `${res.result.settled.length} ${tg.cash.willSettleCount}` +
          (res.result.farmBalanceD > 0
            ? ` · ${tg.cash.remainingOwed} ${diramToSomoniString(res.result.farmBalanceD)}`
            : ""),
      });
      if (res.result.disbursementId) {
        window.open(`/pardokht/nakd/${res.result.disbursementId}`, "_blank");
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4 p-5">
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-lg font-semibold">{farm.name}</h2>
        {farm.tin && <span className="text-sm text-ink-faint">{tg.ticket.tin} {farm.tin}</span>}
        <button onClick={onCancel} className="ms-auto btn-secondary">{tg.common.back}</button>
      </header>

      {/* What this farm has with us, before anything is asked for. */}
      <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-lg bg-paper px-4 py-3">
        <Figure
          label={tg.cash.cottonInHand}
          value={`${gramsToKgString(farm.inHandG, 0)} ${tg.common.kg}`}
        />
        <Figure
          label={tg.cash.readyToSettle}
          value={`${gramsToKgString(farm.readyG, 0)} ${tg.common.kg}`}
          note={`${farm.readyTickets} ${tg.cash.willSettleCount}`}
          tone="brand"
        />
        {farm.atLabG > 0 && (
          <Figure
            label={tg.cash.atLab}
            value={`${gramsToKgString(farm.atLabG, 0)} ${tg.common.kg}`}
            tone="warn"
          />
        )}
        {farm.advanceD > 0 && (
          <Figure
            label={tg.advance.outstanding}
            value={`${diramToSomoniString(farm.advanceD)} ${tg.common.somoni}`}
            tone="warn"
          />
        )}
        {farm.owedD > 0 && (
          <Figure
            label={tg.cash.weOweFarm}
            value={`${diramToSomoniString(farm.owedD)} ${tg.common.somoni}`}
            tone="warn"
          />
        )}
      </div>

      {farm.readyTickets === 0 ? (
        <p className="rounded-lg border border-warn bg-amber-50 px-4 py-3 text-warn">
          {tg.cash.nothingReady}
          {farm.atLabG > 0 && ` — ${tg.cash.atLab}: ${gramsToKgString(farm.atLabG, 0)} ${tg.common.kg}`}
        </p>
      ) : (
        <>
          <div>
            <label className="label" htmlFor="ask">{tg.cash.howMuchAsked}</label>
            <input
              id="ask"
              inputMode="decimal"
              autoFocus
              disabled={everything}
              className="input-number text-3xl"
              placeholder="6000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <p className="mt-1 text-xs text-ink-faint">{tg.cash.askedHint}</p>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={everything}
                     onChange={(e) => setEverything(e.target.checked)} />
              {tg.cash.payEverything}
            </label>
          </div>

          {amountInvalid && (
            <p role="alert" className="text-sm font-medium text-alarm">
              {tg.cash.amountNotValid}
            </p>
          )}

          {planning && <p className="text-sm text-ink-faint">{tg.common.loading}</p>}

          {/* Money already owed goes out first and sells no cotton — worth saying plainly,
              because "we paid you and sold nothing" is a different transaction from
              "we sold ten tonnes at today's price". */}
          {plan && plan.fromBalanceD > 0 && (
            <div className="rounded-lg border border-brand bg-brand-light px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <div>
                  <div className="text-sm text-brand-dark">{tg.cash.fromBalance}</div>
                  <div className="tabular text-2xl font-bold text-brand-dark">
                    {diramToSomoniString(plan.fromBalanceD)} {tg.common.somoni}
                  </div>
                </div>
                {plan.tickets.length === 0 && (
                  <span className="badge bg-white text-brand-dark">{tg.cash.noCottonSold}</span>
                )}
              </div>
              <p className="mt-1 text-xs text-brand-dark/80">{tg.cash.fromBalanceHint}</p>
            </div>
          )}

          {plan && plan.tickets.length === 0 && plan.fromBalanceD > 0 && (
            <div className="space-y-3 rounded-lg border border-paper-line p-4">
              <label className="flex items-start gap-3 rounded-lg border border-paper-line p-3">
                <input type="checkbox" className="mt-1" checked={copyCollected}
                       onChange={(e) => setCopyCollected(e.target.checked)} />
                <span className="font-medium">{tg.cash.confirmPay}</span>
              </label>
              {notEnoughCash && (
                <p role="alert" className="text-sm font-medium text-alarm">
                  {tg.cash.notEnoughCash} — {tg.cash.cashOnHand}{" "}
                  {diramToSomoniString(cashOnHandD)} {tg.common.somoni}
                </p>
              )}
              <button
                onClick={pay}
                disabled={busy || !copyCollected || notEnoughCash}
                className="btn-primary btn-lg w-full"
              >
                {busy
                  ? tg.common.loading
                  : `${tg.cash.payOut} — ${diramToSomoniString(plan.disburseD)} ${tg.common.somoni}`}
              </button>
            </div>
          )}

          {plan && plan.tickets.length > 0 && (
            <div className="space-y-3 rounded-lg border border-paper-line p-4">
              <h3 className="text-sm font-semibold text-ink-soft">
                {tg.cash.willSettle} — {plan.tickets.length} {tg.cash.willSettleCount}
              </h3>
              <ul className="divide-y divide-paper-line text-sm">
                {plan.tickets.map((t) => (
                  <li key={t.ticketId} className="flex flex-wrap items-baseline gap-x-4 py-1.5">
                    <span className="font-mono text-xs text-brand">{t.serial}</span>
                    <span className="tabular text-ink-soft">
                      {gramsToKgString(t.netG, 1)} {tg.common.kg}
                    </span>
                    <span className="ms-auto tabular font-semibold">
                      {diramToSomoniString(t.grossAmountD)}
                    </span>
                    {t.advanceOffsetD > 0 && (
                      <span className="tabular text-xs text-warn">
                        − {diramToSomoniString(t.advanceOffsetD)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <dl className="divide-y divide-paper-line text-sm">
                <Line label={tg.cash.grossAmount} value={diramToSomoniString(plan.grossAmountD)} />
                {plan.advanceOffsetD > 0 && (
                  <Line label={tg.cash.advanceOffset}
                        value={`− ${diramToSomoniString(plan.advanceOffsetD)}`} tone="warn" />
                )}
                <Line label={tg.cash.newlySettled}
                      value={diramToSomoniString(plan.cashPayableD)} strong />
                {plan.fromBalanceD > 0 && (
                  <Line label={tg.cash.fromBalance}
                        value={diramToSomoniString(plan.fromBalanceD)} />
                )}
              </dl>

              <div className="flex flex-wrap gap-6 rounded-lg bg-brand-light px-4 py-3">
                <div>
                  <div className="text-sm text-brand-dark">{tg.cash.paidNow}</div>
                  <div className="tabular text-3xl font-bold text-brand-dark">
                    {diramToSomoniString(plan.disburseD)} {tg.common.somoni}
                  </div>
                </div>
                {plan.remainderD > 0 && (
                  <div>
                    <div className="text-sm text-warn">{tg.cash.remainingOwed}</div>
                    <div className="tabular text-3xl font-bold text-warn">
                      {diramToSomoniString(plan.remainderD)} {tg.common.somoni}
                    </div>
                  </div>
                )}
              </div>

              {plan.shortfallD > 0 && (
                <p className="rounded-lg border border-warn bg-amber-50 px-3 py-2 text-sm text-warn">
                  {tg.cash.notEnoughCotton} · {tg.cash.shortBy}{" "}
                  <strong className="tabular">{diramToSomoniString(plan.shortfallD)}</strong>{" "}
                  {tg.common.somoni} · {tg.cash.offerInstead}{" "}
                  <strong className="tabular">{diramToSomoniString(plan.disburseD)}</strong>
                </p>
              )}

              {plan.unpriced.length > 0 && (
                <p className="text-xs text-warn">
                  {tg.cash.noPriceForSome}: {plan.unpriced.join(", ")}
                </p>
              )}

              {notEnoughCash && (
                <p role="alert" className="text-sm font-medium text-alarm">
                  {tg.cash.notEnoughCash} — {tg.cash.cashOnHand}{" "}
                  {diramToSomoniString(cashOnHandD)} {tg.common.somoni}
                </p>
              )}

              <label className="flex items-start gap-3 rounded-lg border border-paper-line p-3">
                <input type="checkbox" className="mt-1" checked={copyCollected}
                       onChange={(e) => setCopyCollected(e.target.checked)} />
                <span>
                  <span className="font-medium">{tg.cash.collectCopy}</span>
                  <span className="block text-sm text-ink-soft">
                    {plan.tickets.map((t) => t.serial).join(" · ")}
                  </span>
                </span>
              </label>

              <button
                onClick={pay}
                disabled={busy || !copyCollected || notEnoughCash}
                className="btn-primary btn-lg w-full"
              >
                {busy
                  ? tg.common.loading
                  : `${tg.cash.settleAndPay} — ${diramToSomoniString(plan.disburseD)} ${tg.common.somoni}`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Figure({
  label, value, note, tone,
}: { label: string; value: string; note?: string; tone?: "brand" | "warn" }) {
  return (
    <div>
      <div className="text-xs text-ink-faint">{label}</div>
      <div
        className={`tabular text-lg font-semibold ${
          tone === "brand" ? "text-brand" : tone === "warn" ? "text-warn" : ""
        }`}
      >
        {value}
      </div>
      {note && <div className="text-xs text-ink-faint">{note}</div>}
    </div>
  );
}

function Line({
  label, value, strong, tone,
}: { label: string; value: string; strong?: boolean; tone?: "warn" }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-ink-soft">{label}</dt>
      <dd
        className={`tabular ${strong ? "text-lg font-bold" : ""} ${
          tone === "warn" ? "text-warn" : ""
        }`}
      >
        {value} {tg.common.somoni}
      </dd>
    </div>
  );
}
