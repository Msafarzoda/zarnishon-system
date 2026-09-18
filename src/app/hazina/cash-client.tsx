"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  bpToPercentString,
  diramToSomoniString,
  gramsToKgString,
  somoniStringToDiram,
} from "@/domain/units";
import { settleTicket } from "@/domain/settlement";
import { normaliseTin } from "@/domain/plate";
import { submit } from "@/lib/offline/station-client";
import { PriceTrendStat } from "@/components/price-trend";
import { SearchableSelect } from "@/components/searchable-select";
import { PayFarmPanel } from "./pay-farm-panel";
import type { PriceTrend } from "@/server/services/price-trend";
import { tg } from "@/lib/i18n/tg";

interface UnpaidTicket {
  id: string;
  serial: string;
  netG: number;
  deductionBp: number;
  weighedAt: string | null;
  farmId: string;
  farm: string;
  tin: string | null;
  plate: string | null;
  batchNumber: number | null;
  variety: string | null;
  advanceD: number;
  /** The price this ticket's variety resolves to today — null when none is in force. */
  priceDPerKg: number | null;
}

/** A farm as the cash desk needs to see it: cotton, credit and debt in one row. */
export interface FarmRow {
  id: string;
  name: string;
  tin: string | null;
  phone: string | null;
  /** Нетто standing in our warehouse, unsettled. */
  inHandG: number;
  /** Of that, what the lab has cleared — the only part sellable today. */
  readyG: number;
  readyTickets: number;
  atLabG: number;
  advanceD: number;
  owedD: number;
  maxAdvanceD: number;
  headroomD: number;
  overLent: boolean;
}

export interface ExpenseCategoryRow {
  id: string;
  nameTg: string;
}

export interface ExpenseRow {
  id: string;
  categoryName: string;
  amountD: number;
  note: string | null;
  occurredAt: string;
  recordedByName: string;
}

export interface OwedFarm {
  id: string;
  name: string;
  phone: string | null;
  owedD: number;
  lastPaidAt: string | null;
  settledAt: string | null;
}

export interface PayoutRow {
  id: string;
  receiptNo: string;
  paidAt: string;
  amountD: number;
  balanceAfterD: number;
  paymentId: string | null;
  reversed: boolean;
  farm: string;
  cashier: string | null;
}

export interface PaidRow {
  paymentId: string;
  invoiceNo: string;
  paidAt: string;
  cashPayableD: number;
  grossAmountD: number;
  advanceOffsetD: number;
  payableG: number;
  reversed: boolean;
  farm: string;
  serial: string;
  cashier: string | null;
}

/**
 * What the desk is being asked to do right now.
 *
 * The screen used to be organised around the system's own distinctions — settlement
 * versus disbursement, by-farm versus by-ticket — which are real and are why the ledger
 * works, but they are not what the cashier is thinking about. He is thinking "Ҳакимов is
 * at the window and wants two thousand". So the four things that actually happen at this
 * window lead, in their own words, and the machinery arranges itself underneath.
 */
type Job = "pay" | "lend" | "receive" | "ticket" | "spend";

export function CashClient({
  cashOnHandD, totalOwedD, owedFarms, payouts, trend, advanceRateDPerKg, priceError,
  tickets, farms, onScale, awaitingLab, history, readOnly, buyersOweD,
  expenseCategories, recentExpenses,
}: {
  cashOnHandD: number;
  /** Diram a farm may borrow per kg of cotton in hand. docs/domain.md §4. */
  advanceRateDPerKg: number;
  /** Everything the factory owes settled farms — the other half of what the drawer means. */
  totalOwedD: number;
  owedFarms: OwedFarm[];
  payouts: PayoutRow[];
  trend: PriceTrend;
  priceError: string | null;
  tickets: UnpaidTicket[];
  farms: FarmRow[];
  /** Loads still upstream — shown so an empty list explains itself. */
  onScale: number;
  awaitingLab: number;
  history: PaidRow[];
  readOnly?: boolean;
  /** §7: what buyers of чигит, улюк, пучоқ and кип still owe us. */
  buyersOweD: number;
  /** §4 маош/ошхона/таъмир — cash out that is not cotton. */
  expenseCategories: ExpenseCategoryRow[];
  recentExpenses: ExpenseRow[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [payingFarm, setPayingFarm] = useState<OwedFarm | null>(null);
  const [settlingFarmId, setSettlingFarmId] = useState<string | null>(null);
  const [job, setJob] = useState<Job>("pay");
  const [showHistory, setShowHistory] = useState(false);

  /** Switching jobs clears whatever the last one had half-open. */
  function chooseJob(next: Job) {
    setJob(next);
    setSelectedId(null);
    setSettlingFarmId(null);
    setPayingFarm(null);
    setQuery("");
  }

  const settlingFarm = farms.find((f) => f.id === settlingFarmId) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter(
      (t) =>
        t.serial.toLowerCase().includes(q) ||
        t.farm.toLowerCase().includes(q) ||
        (t.plate ?? "").toLowerCase().includes(q) ||
        (t.tin ?? "").includes(q),
    );
  }, [query, tickets]);

  const selected = tickets.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={tg.cash.cashOnHand}
          value={`${diramToSomoniString(cashOnHandD)} ${tg.common.somoni}`}
          tone={totalOwedD > cashOnHandD ? "bad" : undefined}
          hint={totalOwedD > cashOnHandD ? tg.cash.cashShort : undefined}
        />
        {/* What the drawer owes is as much a fact of the desk as what it holds. */}
        <Stat
          label={tg.cash.weOwe}
          value={`${diramToSomoniString(totalOwedD)} ${tg.common.somoni}`}
          hint={owedFarms.length > 0 ? `${owedFarms.length} × ${tg.ticket.consignor}` : undefined}
          tone={totalOwedD > 0 ? "warn" : undefined}
        />
        <PriceTrendStat trend={trend} />
        <Stat
          label={tg.dashboard.unpaidTickets}
          value={String(tickets.length)}
          hint={tickets.length > 0 ? tg.cash.waitingByChoice : undefined}
        />
      </div>

      {priceError && (
        <div role="alert" className="card border-alarm bg-red-50 px-4 py-3 text-alarm">
          {priceError}
        </div>
      )}

      {notice && (
        <div role="status"
             className={`card px-4 py-3 ${
               notice.tone === "ok"
                 ? "border-brand bg-brand-light text-brand-dark"
                 : "border-alarm bg-red-50 text-alarm"
             }`}>
          {notice.text}
        </div>
      )}

      {/* The four jobs. Each carries the number that says whether it has work waiting, so
          the cashier can see there are three farms to pay without opening anything. */}
      {!readOnly && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <JobCard
            active={job === "pay"}
            onClick={() => chooseJob("pay")}
            title={tg.cash.jobPayFarm}
            hint={tg.cash.jobPayFarmHint}
            figure={owedFarms.length > 0 ? `${diramToSomoniString(totalOwedD)} ${tg.common.somoni}` : undefined}
            count={owedFarms.length}
          />
          <JobCard
            active={job === "lend"}
            onClick={() => chooseJob("lend")}
            title={tg.cash.jobLend}
            hint={tg.cash.jobLendHint}
            figure={`${diramToSomoniString(advanceRateDPerKg)} ${tg.common.somoni}/${tg.common.kg}`}
          />
          <JobCard
            active={job === "receive"}
            onClick={() => chooseJob("receive")}
            title={tg.cash.jobTakeMoney}
            hint={tg.cash.jobTakeMoneyHint}
            figure={buyersOweD > 0 ? `${diramToSomoniString(buyersOweD)} ${tg.common.somoni}` : undefined}
          />
          <JobCard
            active={job === "ticket"}
            onClick={() => chooseJob("ticket")}
            title={tg.cash.jobSettleTicket}
            hint={tg.cash.jobSettleTicketHint}
            count={tickets.length}
          />
          <JobCard
            active={job === "spend"}
            onClick={() => chooseJob("spend")}
            title={tg.cash.jobSpend}
            hint={tg.cash.jobSpendHint}
          />
        </div>
      )}

      {/* ---- Job: pay a farm. The ordinary case, and the one with somebody waiting. */}
      {(job === "pay" || readOnly) && (
        <>
          {owedFarms.length > 0 && (
            <section className="card border-warn bg-amber-50/40 p-4">
              <h2 className="mb-3 text-sm font-semibold text-warn">
                {tg.cash.owedFarms} — {diramToSomoniString(totalOwedD)} {tg.common.somoni}
              </h2>
              <ul className="space-y-2">
                {owedFarms.map((f) => (
                  <li
                    key={f.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-white px-3 py-2"
                  >
                    <span className="min-w-40 flex-1 font-medium">{f.name}</span>
                    {f.phone && <span className="tabular text-xs text-ink-faint">{f.phone}</span>}
                    <span className="tabular text-lg font-bold text-warn">
                      {diramToSomoniString(f.owedD)} {tg.common.somoni}
                    </span>
                    {!readOnly && (
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => { setPayingFarm(f); setSelectedId(null); }}
                      >
                        {tg.cash.payOut}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {payingFarm && !readOnly && (
            <PayoutPanel
              farm={payingFarm}
              cashOnHandD={cashOnHandD}
              onCancel={() => setPayingFarm(null)}
              onNotice={setNotice}
              onDone={() => { setPayingFarm(null); router.refresh(); }}
            />
          )}

          {!payingFarm && (
            settlingFarm && !readOnly ? (
              <PayFarmPanel
                farm={settlingFarm}
                cashOnHandD={cashOnHandD}
                onCancel={() => setSettlingFarmId(null)}
                onNotice={setNotice}
                onDone={() => { setSettlingFarmId(null); router.refresh(); }}
              />
            ) : (
              <>
                <input
                  className="input w-full"
                  placeholder={tg.cash.chooseFarm}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus
                />
                <FarmChooser
                  farms={farms}
                  query={query}
                  advanceRateDPerKg={advanceRateDPerKg}
                  readOnly={readOnly}
                  onPick={setSettlingFarmId}
                />
              </>
            )
          )}
        </>
      )}

      {/* ---- Job: lend against cotton standing in our warehouse. */}
      {job === "lend" && !readOnly && (
        <AdvanceForm
          farms={farms}
          advanceRateDPerKg={advanceRateDPerKg}
          onNotice={setNotice}
          onDone={() => router.refresh()}
        />
      )}

      {/* ---- Job: take money from a buyer of чигит, улюк, пучоқ or кип.
          The panel itself lives on Фурӯш, beside the sales it is settling, rather than
          being built twice. This card is here because the buyer walks up to *this*
          window, so the desk has to be told the money is expected. */}
      {job === "receive" && !readOnly && (
        <section className="card p-5">
          <h2 className="text-lg font-semibold">{tg.cash.jobTakeMoney}</h2>
          <p className="mt-1 text-sm text-ink-soft">{tg.cash.jobTakeMoneyHint}</p>
          <div className="mt-3 tabular text-3xl font-bold text-warn">
            {diramToSomoniString(buyersOweD)} {tg.common.somoni}
          </div>
          <a className="btn-primary mt-4 inline-block" href="/furush">
            {tg.sales.owedByBuyers} →
          </a>
        </section>
      )}

      {/* ---- Job: settle one particular борхат the farmer has brought in. */}
      {job === "ticket" && !readOnly && (
        selected && selected.priceDPerKg !== null ? (
          <PaymentPanel
            ticket={selected}
            priceDPerKg={selected.priceDPerKg}
            cashOnHandD={cashOnHandD}
            onCancel={() => setSelectedId(null)}
            onNotice={setNotice}
            onDone={() => { setSelectedId(null); router.refresh(); }}
          />
        ) : (
          <>
            <input
              className="input w-full"
              placeholder={tg.cash.scanTicket}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <ul className="space-y-2">
              {filtered.length === 0 && (
                <li className="card p-8 text-center">
                  <p className="text-ink-faint">{tg.common.nothingFound}</p>
                  {(awaitingLab > 0 || onScale > 0) && (
                    <p className="mt-2 text-sm text-warn">
                      {awaitingLab > 0 && (
                        <>
                          {tg.cash.awaitingLabCount}: <strong>{awaitingLab}</strong>
                        </>
                      )}
                      {awaitingLab > 0 && onScale > 0 && " · "}
                      {onScale > 0 && (
                        <>
                          {tg.cash.onScaleCount}: <strong>{onScale}</strong>
                        </>
                      )}
                    </p>
                  )}
                </li>
              )}
              {filtered.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(t.id)}
                    disabled={t.priceDPerKg === null}
                    title={t.priceDPerKg === null ? tg.price.onlyOwner : undefined}
                    className="card flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-paper disabled:opacity-50"
                  >
                    <span className="font-mono text-brand">{t.serial}</span>
                    <span className="font-medium">{t.farm}</span>
                    {t.batchNumber !== null && (
                      <span className="badge bg-paper text-ink-soft">
                        {tg.ticket.batch} {t.batchNumber}
                      </span>
                    )}
                    {t.advanceD > 0 && (
                      <span className="badge bg-amber-100 text-warn">
                        {tg.advance.outstanding} {diramToSomoniString(t.advanceD)}
                      </span>
                    )}
                    <span className="ms-auto text-end">
                      <span className="tabular block font-semibold">
                        {gramsToKgString(t.netG, 1)} {tg.common.kg}
                      </span>
                      {/* What it is worth if he takes it today. The only question he asks. */}
                      {t.priceDPerKg !== null && (
                        <span className="tabular block text-xs text-ink-soft">
                          ≈ {diramToSomoniString(valueToday(t))} {tg.common.somoni}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      )}

      {/* ---- Job: spend cash on something that is not cotton — payroll, kitchen, repairs. */}
      {job === "spend" && !readOnly && (
        <ExpenseForm
          categories={expenseCategories}
          recentExpenses={recentExpenses}
          onNotice={setNotice}
          onDone={() => router.refresh()}
        />
      )}

      {/* The two histories are a day's worth of reading and were pushing the actual work
          below the fold. They are kept — a cashier does get asked "who did we pay?" — but
          behind one click, because that question is asked far less often than the four
          above are answered. */}
      {(history.length > 0 || payouts.length > 0) && (
        <div>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setShowHistory((v) => !v)}
          >
            {showHistory ? tg.cash.hideHistory : tg.cash.showHistory}
          </button>
          {showHistory && (
            <div className="mt-3 space-y-5">
              {history.length > 0 && <PaymentHistory history={history} />}
              {payouts.length > 0 && <PayoutHistory payouts={payouts} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One of the four jobs, as a target big enough to hit with a thumb on a tablet.
 *
 * The figure is the point: "Пул додан ба хоҷагӣ · 18 400.00 сомонӣ · 3" says there is
 * work and how much of it, without opening anything. A card with nothing waiting shows
 * no figure rather than a zero, so the eye goes to the ones that do.
 */
function JobCard({
  active, onClick, title, hint, figure, count,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  hint: string;
  figure?: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`card px-4 py-3 text-start transition ${
        active ? "border-brand bg-brand-light" : "hover:bg-paper"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">{title}</span>
        {count !== undefined && count > 0 && (
          <span className="badge bg-warn/15 text-warn tabular">{count}</span>
        )}
      </div>
      <div className="text-xs text-ink-faint">{hint}</div>
      {figure && <div className="mt-2 tabular text-lg font-bold">{figure}</div>}
    </button>
  );
}

/** Today's value of an unpaid load, at today's price and its own lab deduction. */
function valueToday(t: UnpaidTicket): number {
  const s = settleTicket({
    netG: t.netG,
    deductionBp: t.deductionBp,
    priceDPerKg: t.priceDPerKg ?? 0,
    outstandingAdvanceD: 0,
  });
  return s.grossAmountD;
}

function Stat({
  label, value, tone, hint,
}: { label: string; value: string; tone?: "bad" | "warn"; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-sm text-ink-soft">{label}</div>
      <div
        className={`tabular text-2xl font-bold leading-tight ${
          tone === "bad" ? "text-alarm" : tone === "warn" ? "text-warn" : ""
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

// --------------------------------------------------------------------- payment

/**
 * Settling one борхат, and handing over however much of it the farm actually wants.
 *
 * The two are separate questions and the panel asks them in that order: this is what the
 * cotton came to, and this is what leaves the drawer today. A farm owed 6 000 routinely
 * takes 2 000, and some days the drawer cannot cover it either way — so the amount is a
 * field with the full sum as its default, not a fixed consequence of pressing the button.
 */
function PaymentPanel({
  ticket, priceDPerKg, cashOnHandD, onCancel, onNotice, onDone,
}: {
  ticket: UnpaidTicket;
  priceDPerKg: number;
  cashOnHandD: number;
  onCancel: () => void;
  onNotice: (n: { tone: "ok" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const [copyCollected, setCopyCollected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState<string | null>(null); // null = the whole payable

  // The same pure function the server settles with, so what the cashier reads on screen
  // is what the ledger will record — not a second implementation that can drift.
  const s = settleTicket({
    netG: ticket.netG,
    deductionBp: ticket.deductionBp,
    priceDPerKg,
    outstandingAdvanceD: ticket.advanceD,
  });

  // `null` means "all of it" — the ordinary case, and the one that must not depend on a
  // text field being parsed correctly.
  let handOverD = s.cashPayableD;
  let amountError: string | null = null;
  if (amount !== null) {
    if (amount.trim() === "") {
      handOverD = 0;
    } else {
      try {
        handOverD = somoniStringToDiram(amount);
      } catch {
        handOverD = 0;
        amountError = tg.cash.amountNotValid;
      }
    }
    if (handOverD > s.cashPayableD) amountError = tg.cash.moreThanTicket;
    else if (handOverD > cashOnHandD) amountError = tg.cash.notEnoughCash;
  }
  const remainingD = s.cashPayableD - handOverD;

  async function pay() {
    setBusy(true);
    try {
      const res = await submit<{
        paymentId: string; invoiceNo: string; cashPayableD: number;
        disbursedD: number; farmBalanceD: number;
      }>(
        "/api/payments",
        {
          ticketId: ticket.id,
          copyCollected,
          disburseD: handOverD,
          paidAt: new Date().toISOString(),
        },
      );

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
          `${ticket.farm} — ${tg.cash.paidNow} ${diramToSomoniString(res.result.disbursedD)} ` +
          `${tg.common.somoni}` +
          (res.result.farmBalanceD > 0
            ? ` · ${tg.cash.remainingOwed} ${diramToSomoniString(res.result.farmBalanceD)} ` +
              `${tg.common.somoni}`
            : "") +
          ` · ${res.result.invoiceNo}`,
      });
      // The farmer leaves with a receipt, the same way he leaves the scale with a Борхат.
      window.open(`/pardokht/${res.result.paymentId}`, "_blank");
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5 space-y-4">
      <header className="flex items-baseline gap-3 flex-wrap">
        <span className="font-mono text-brand text-lg">{ticket.serial}</span>
        <h2 className="text-lg font-semibold">{ticket.farm}</h2>
        {ticket.tin && <span className="text-sm text-ink-faint">{tg.ticket.tin} {ticket.tin}</span>}
        <button onClick={onCancel} className="ms-auto btn-secondary">{tg.common.back}</button>
      </header>

      <dl className="divide-y divide-paper-line">
        <Row label={tg.ticket.net} value={`${gramsToKgString(ticket.netG, 1)} ${tg.common.kg}`} />
        <Row label={tg.lab.deduction} value={`${bpToPercentString(ticket.deductionBp)} %`} />
        <Row label={tg.cash.payable}
             value={`${gramsToKgString(s.payableG, 2)} ${tg.common.kg}`} strong />
        <Row label={tg.cash.price}
             value={`${diramToSomoniString(priceDPerKg)} ${tg.price.perKg}`} />
        <Row label={tg.cash.grossAmount}
             value={`${diramToSomoniString(s.grossAmountD)} ${tg.common.somoni}`} strong />
        {s.advanceOffsetD > 0 && (
          <Row label={tg.cash.advanceOffset}
               value={`− ${diramToSomoniString(s.advanceOffsetD)} ${tg.common.somoni}`} tone="warn" />
        )}
        {s.remainingAdvanceD > 0 && (
          <Row label={tg.cash.remainingAdvance}
               value={`${diramToSomoniString(s.remainingAdvanceD)} ${tg.common.somoni}`} tone="warn" />
        )}
      </dl>

      <div className="rounded-lg bg-brand-light px-4 py-4">
        <div className="text-sm text-brand-dark">{tg.cash.cashToPay}</div>
        <div className="tabular text-4xl font-bold text-brand-dark">
          {diramToSomoniString(s.cashPayableD)} {tg.common.somoni}
        </div>
      </div>

      {/* How much actually leaves the drawer. Full by default, because that is the common
          case and it must not depend on anyone typing anything. */}
      <div className="space-y-3 rounded-lg border border-paper-line p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="label mb-0">{tg.cash.handOverNow}</span>
          <span className="text-xs text-ink-faint">
            {tg.cash.cashOnHand} {diramToSomoniString(cashOnHandD)} {tg.common.somoni}
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAmount(null)}
            className={amount === null ? "btn-primary" : "btn-secondary"}
          >
            {tg.cash.payFull} — {diramToSomoniString(s.cashPayableD)}
          </button>
          <button
            type="button"
            onClick={() => setAmount("")}
            className={amount === "" ? "btn-primary" : "btn-secondary"}
          >
            {tg.cash.payNothing}
          </button>
          {amount === null && (
            <button type="button" className="btn-secondary"
                    onClick={() => setAmount(diramToSomoniString(s.cashPayableD))}>
              {tg.common.edit}
            </button>
          )}
        </div>

        {amount !== null && amount !== "" && (
          <div>
            <input
              inputMode="decimal"
              autoFocus
              className="input-number text-2xl"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <p className="mt-1 text-xs text-ink-faint">{tg.cash.handOverHint}</p>
          </div>
        )}

        {amount === "" && <p className="text-sm text-warn">{tg.cash.payLaterHint}</p>}

        {amountError && <p role="alert" className="text-sm font-medium text-alarm">{amountError}</p>}

        {!amountError && remainingD > 0 && (
          <div className="flex flex-wrap gap-6 rounded-lg bg-amber-50 px-3 py-2">
            <div>
              <div className="text-xs text-warn">{tg.cash.paidNow}</div>
              <div className="tabular text-xl font-bold text-warn">
                {diramToSomoniString(handOverD)} {tg.common.somoni}
              </div>
            </div>
            <div>
              <div className="text-xs text-warn">{tg.cash.remainingOwed}</div>
              <div className="tabular text-xl font-bold text-warn">
                {diramToSomoniString(remainingD)} {tg.common.somoni}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* The stamped Copy C is the farmer's claim. Taking it in is part of settling —
          including when no cash changes hands, which is why the receipt then becomes the
          farm's proof of what it is still owed. */}
      <label className="flex items-start gap-3 rounded-lg border border-paper-line p-3">
        <input type="checkbox" className="mt-1" checked={copyCollected}
               onChange={(e) => setCopyCollected(e.target.checked)} />
        <span>
          <span className="font-medium">{tg.cash.collectCopy}</span>
          <span className="block text-sm text-ink-soft">{tg.cash.collectCopyHint}</span>
        </span>
      </label>

      <button
        onClick={pay}
        disabled={busy || !copyCollected || amountError !== null}
        className="btn-primary btn-lg w-full"
      >
        {busy
          ? tg.common.loading
          : handOverD === 0
            ? tg.cash.settle
            : `${tg.cash.settleAndPay} — ${diramToSomoniString(handOverD)} ${tg.common.somoni}`}
      </button>
    </div>
  );
}

/**
 * Paying a farm part of what it is already owed — the second, third or fourth visit.
 *
 * Not tied to any one борхат: by the time a farm comes back it may be owed against
 * several, and the money it asks for is against its balance, not against a piece of paper.
 */
function PayoutPanel({
  farm, cashOnHandD, onCancel, onNotice, onDone,
}: {
  farm: OwedFarm;
  cashOnHandD: number;
  onCancel: () => void;
  onNotice: (n: { tone: "ok" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(diramToSomoniString(Math.min(farm.owedD, cashOnHandD)));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  let amountD = 0;
  let error: string | null = null;
  try {
    amountD = amount.trim() ? somoniStringToDiram(amount) : 0;
  } catch {
    error = tg.cash.amountNotValid;
  }
  if (!error) {
    if (amountD <= 0) error = tg.common.required;
    else if (amountD > farm.owedD) error = tg.cash.moreThanOwed;
    else if (amountD > cashOnHandD) error = tg.cash.notEnoughCash;
  }

  async function payOut() {
    setBusy(true);
    try {
      const res = await submit<{
        disbursementId: string; receiptNo: string; balanceAfterD: number;
      }>("/api/disbursements", {
        counterpartyId: farm.id,
        amountD,
        note: note.trim() || undefined,
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
          `${farm.name} — ${diramToSomoniString(amountD)} ${tg.common.somoni}` +
          (res.result.balanceAfterD > 0
            ? ` · ${tg.cash.remainingOwed} ${diramToSomoniString(res.result.balanceAfterD)}`
            : ""),
      });
      window.open(`/pardokht/nakd/${res.result.disbursementId}`, "_blank");
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4 p-5">
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-lg font-semibold">{tg.cash.payOutTitle}</h2>
        <span className="font-medium">{farm.name}</span>
        <button onClick={onCancel} className="ms-auto btn-secondary">{tg.common.back}</button>
      </header>

      <dl className="divide-y divide-paper-line">
        <Row label={tg.cash.weOweFarm}
             value={`${diramToSomoniString(farm.owedD)} ${tg.common.somoni}`} strong />
        <Row label={tg.cash.cashOnHand}
             value={`${diramToSomoniString(cashOnHandD)} ${tg.common.somoni}`}
             tone={cashOnHandD < farm.owedD ? "warn" : undefined} />
      </dl>

      <div>
        <label className="label" htmlFor="payout-amount">{tg.cash.amount}</label>
        <input
          id="payout-amount"
          inputMode="decimal"
          autoFocus
          className="input-number text-2xl"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {[farm.owedD, 300_000, 200_000, 100_000]
            .filter((v, i, a) => v <= farm.owedD && v <= cashOnHandD && a.indexOf(v) === i)
            .map((v) => (
              <button key={v} type="button" className="btn-secondary"
                      onClick={() => setAmount(diramToSomoniString(v))}>
                {diramToSomoniString(v)}
              </button>
            ))}
        </div>
      </div>

      <div>
        <label className="label" htmlFor="payout-note">{tg.common.note}</label>
        <input id="payout-note" className="input" value={note}
               onChange={(e) => setNote(e.target.value)} />
      </div>

      {error && <p role="alert" className="text-sm font-medium text-alarm">{error}</p>}

      {!error && (
        <div className="rounded-lg bg-brand-light px-4 py-3">
          <span className="text-sm text-brand-dark">{tg.cash.balanceAfter}</span>
          <div className="tabular text-2xl font-bold text-brand-dark">
            {diramToSomoniString(farm.owedD - amountD)} {tg.common.somoni}
          </div>
        </div>
      )}

      <button onClick={payOut} disabled={busy || error !== null}
              className="btn-primary btn-lg w-full">
        {busy ? tg.common.loading : `${tg.cash.payOut} — ${diramToSomoniString(amountD)} ${tg.common.somoni}`}
      </button>
    </div>
  );
}

/** Cash that actually left the drawer — a different list from what was settled. */
function PayoutHistory({ payouts }: { payouts: PayoutRow[] }) {
  return (
    <section className="card overflow-x-auto p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink-soft">{tg.cash.disbursementHistory}</h2>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-paper-line">
          {payouts.map((d) => (
            <tr key={d.id} className={d.reversed ? "opacity-50 line-through" : ""}>
              <td className="py-1.5 tabular text-ink-faint">
                {new Date(d.paidAt).toLocaleString("ru-RU", {
                  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                })}
              </td>
              <td className="py-1.5">{d.farm}</td>
              <td className="py-1.5 text-xs text-ink-faint">
                {d.paymentId ? tg.cash.againstTicket : tg.cash.againstBalance}
              </td>
              <td className="py-1.5 text-end tabular font-semibold">
                {diramToSomoniString(d.amountD)}
              </td>
              <td className="py-1.5 text-end tabular text-xs text-warn">
                {d.balanceAfterD > 0 ? diramToSomoniString(d.balanceAfterD) : "—"}
              </td>
              <td className="py-1.5 text-end">
                <a href={`/pardokht/nakd/${d.id}`} className="text-brand hover:underline">
                  {tg.cash.receipt}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Row({
  label, value, strong, tone,
}: { label: string; value: string; strong?: boolean; tone?: "warn" }) {
  return (
    <div className="flex items-baseline justify-between py-2">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={`tabular ${strong ? "text-lg font-semibold" : ""} ${tone === "warn" ? "text-warn" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

// -------------------------------------------------------------------- advance

/**
 * Қарз — lending against cotton in the warehouse.
 *
 * Nothing is lent without collateral, so the panel leads with the collateral: this farm
 * has so many kilograms standing in our shed, which at the owner's rate is worth so much,
 * less what it already owes. docs/domain.md §4.
 */
function AdvanceForm({
  farms, advanceRateDPerKg, onNotice, onDone,
}: {
  farms: FarmRow[];
  advanceRateDPerKg: number;
  onNotice: (n: { tone: "ok" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const [counterpartyId, setCounterpartyId] = useState("");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState<string>(tg.advance.purposeDefault);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await submit<{ advanceId: string }>("/api/advances", {
        counterpartyId,
        principalD: somoniStringToDiram(amount),
        purpose,
      });
      if (res.kind !== "applied") {
        onNotice({
          tone: "bad",
          text: res.kind === "rejected" ? res.message : `${tg.app.offline} — ${tg.advance.issue}`,
        });
        return;
      }
      onNotice({
        tone: "ok",
        text: `${tg.advance.title}: ${amount} ${tg.common.somoni}`,
      });
      onDone();
    } catch {
      onNotice({ tone: "bad", text: tg.common.error });
    } finally {
      setBusy(false);
    }
  }

  const farm = farms.find((f) => f.id === counterpartyId) ?? null;

  /*
   * The limit is shown before the amount is typed, and the amount is checked against it as
   * it is typed. The server refuses an over-limit loan regardless — but a cashier who only
   * finds out after pressing the button has already told the farmer a number.
   */
  let amountD = 0;
  let error: string | null = null;
  if (amount.trim()) {
    try {
      amountD = somoniStringToDiram(amount);
    } catch {
      error = tg.cash.amountNotValid;
    }
  }
  if (!error && farm) {
    if (farm.inHandG === 0) error = tg.cash.noCollateral;
    else if (amountD > farm.headroomD) {
      // The limit itself, in words and with the number — "Ҳадди қарз" alone is a column
      // heading, and a cashier reading it under a field does not learn what to type.
      error =
        `${tg.cash.overLimitPrefix} ${diramToSomoniString(farm.headroomD)} ${tg.common.somoni}`;
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-5 space-y-4">
      <h2 className="font-semibold">{tg.advance.issue}</h2>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="adv-farm">{tg.ticket.consignor}</label>
          <SearchableSelect
            id="adv-farm"
            required
            value={counterpartyId}
            onChange={setCounterpartyId}
            options={farms.map((f) => ({
              value: f.id,
              label: f.tin ? `${f.name} · ${f.tin}` : f.name,
            }))}
          />
        </div>
        <div>
          <label className="label" htmlFor="adv-amount">{tg.advance.principal}</label>
          <input id="adv-amount" inputMode="decimal" required className="input-number"
                 placeholder="5000" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="adv-purpose">{tg.advance.purpose}</label>
          <input id="adv-purpose" className="input" value={purpose}
                 onChange={(e) => setPurpose(e.target.value)} />
        </div>
      </div>

      {/* Why this farm may borrow what it may — the cotton is the whole reason. */}
      {farm && (
        <div
          className={`rounded-lg border p-4 ${
            farm.inHandG === 0
              ? "border-alarm bg-red-50"
              : "border-paper-line bg-paper"
          }`}
        >
          {farm.inHandG === 0 ? (
            <p className="font-medium text-alarm">{tg.cash.noCollateral}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Figure
                  label={tg.cash.cottonInHand}
                  value={`${gramsToKgString(farm.inHandG, 0)} ${tg.common.kg}`}
                />
                <Figure
                  label={tg.cash.maxAdvance}
                  value={`${diramToSomoniString(farm.maxAdvanceD)} ${tg.common.somoni}`}
                />
                {farm.advanceD > 0 && (
                  <Figure
                    label={tg.advance.outstanding}
                    value={`− ${diramToSomoniString(farm.advanceD)} ${tg.common.somoni}`}
                    tone="warn"
                  />
                )}
                <Figure
                  label={tg.cash.canBorrowNow}
                  value={`${diramToSomoniString(farm.headroomD)} ${tg.common.somoni}`}
                  tone="brand"
                />
              </div>
              <p className="mt-2 text-xs text-ink-faint">
                {tg.cash.lendingRate} {diramToSomoniString(advanceRateDPerKg)} {tg.common.somoni}
                {" · "}
                {tg.cash.lendingLimitHint}
              </p>
              {farm.overLent && (
                <p className="mt-2 text-sm font-medium text-warn">{tg.cash.overLent}</p>
              )}
            </>
          )}
        </div>
      )}

      {/* Not repeated when the panel above already says it — one refusal, one place. */}
      {error && error !== tg.cash.noCollateral && (
        <p role="alert" className="text-sm font-medium text-alarm">{error}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || !counterpartyId || !amount || error !== null}
          className="btn-primary"
        >
          {busy ? tg.common.loading : tg.advance.issue}
        </button>
        {farm && farm.headroomD > 0 && (
          <button type="button" className="btn-secondary"
                  onClick={() => setAmount(diramToSomoniString(farm.headroomD))}>
            {tg.cash.maxAdvance} — {diramToSomoniString(farm.headroomD)}
          </button>
        )}
      </div>
    </form>
  );
}

// -------------------------------------------------------------------- expense

/**
 * Харочот — cash out for something that is not cotton: payroll, kitchen supplies, a
 * repair. Kept apart from paying a хоҷагӣ or lending against its cotton so "how much
 * cotton cost us" and "what it costs to run the factory" are never the same number by
 * accident. docs/domain.md §4.
 */
function ExpenseForm({
  categories, recentExpenses, onNotice, onDone,
}: {
  categories: ExpenseCategoryRow[];
  recentExpenses: ExpenseRow[];
  onNotice: (n: { tone: "ok" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryList, setCategoryList] = useState(categories);

  async function onAddCategory() {
    const nameTg = newCategoryName.trim();
    if (!nameTg) return;
    setBusy(true);
    try {
      // Unlike a farm or a truck, a category has no client-assigned id to work with
      // offline — it needs the server's answer to be usable at all, so this one waits
      // for a real connection rather than queuing.
      const res = await submit<{ id: string; nameTg: string }>("/api/expense-categories", { nameTg });
      if (res.kind !== "applied") {
        onNotice({
          tone: "bad",
          text: res.kind === "rejected" ? res.message : `${tg.app.offline} — ${tg.expense.addCategory}`,
        });
        return;
      }
      const created = res.result;
      setCategoryList((list) =>
        list.some((c) => c.nameTg === created.nameTg) ? list : [...list, created],
      );
      setCategoryId(created.id);
      setNewCategoryName("");
      setAddingCategory(false);
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await submit<{ expenseId: string }>("/api/expenses", {
        categoryId,
        amountD: somoniStringToDiram(amount),
        note: note.trim() || undefined,
      });
      if (res.kind !== "applied") {
        onNotice({
          tone: "bad",
          text: res.kind === "rejected" ? res.message : `${tg.app.offline} — ${tg.expense.record}`,
        });
        return;
      }
      const category = categoryList.find((c) => c.id === categoryId);
      onNotice({
        tone: "ok",
        text: `${category?.nameTg ?? tg.expense.title}: ${amount} ${tg.common.somoni}`,
      });
      setAmount("");
      setNote("");
      onDone();
    } catch {
      onNotice({ tone: "bad", text: tg.common.error });
    } finally {
      setBusy(false);
    }
  }

  let amountError: string | null = null;
  if (amount.trim()) {
    try {
      somoniStringToDiram(amount);
    } catch {
      amountError = tg.cash.amountNotValid;
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form onSubmit={onSubmit} className="card p-5 space-y-4">
        <h2 className="font-semibold">{tg.expense.record}</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <div className="flex items-end justify-between gap-2">
              <label className="label mb-0" htmlFor="exp-category">{tg.expense.category}</label>
              <button
                type="button"
                onClick={() => { setAddingCategory((v) => !v); setNewCategoryName(""); }}
                className="mb-1 rounded px-2 py-0.5 text-sm font-medium text-brand hover:bg-brand-light"
              >
                {addingCategory ? tg.common.cancel : tg.expense.addCategory}
              </button>
            </div>
            {categoryList.length > 0 ? (
              <select id="exp-category" required className="input mt-1" value={categoryId}
                      onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">—</option>
                {categoryList.map((c) => <option key={c.id} value={c.id}>{c.nameTg}</option>)}
              </select>
            ) : (
              <p className="mt-1 text-sm text-ink-faint">{tg.expense.noCategoryYet}</p>
            )}
            {addingCategory && (
              <div className="mt-2 flex gap-2 rounded-lg border border-brand/30 bg-brand-light/50 p-3">
                <input
                  className="input"
                  placeholder={tg.expense.newCategoryPlaceholder}
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                />
                <button type="button" onClick={onAddCategory} disabled={busy || !newCategoryName.trim()}
                        className="btn-primary shrink-0">
                  {tg.common.save}
                </button>
              </div>
            )}
          </div>
          <div>
            <label className="label" htmlFor="exp-amount">{tg.expense.amount}</label>
            <input id="exp-amount" inputMode="decimal" required className="input-number"
                   placeholder="500" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="exp-note">{tg.expense.note}</label>
            <input id="exp-note" className="input" value={note}
                   onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        {amountError && <p role="alert" className="text-sm font-medium text-alarm">{amountError}</p>}

        <button
          type="submit"
          disabled={busy || !categoryId || !amount || amountError !== null}
          className="btn-primary"
        >
          {busy ? tg.common.loading : tg.expense.record}
        </button>
      </form>

      <div className="card p-5">
        <h2 className="font-semibold">{tg.expense.recent}</h2>
        {recentExpenses.length === 0 ? (
          <p className="mt-2 text-sm text-ink-faint">{tg.expense.noneYet}</p>
        ) : (
          <ul className="mt-2 divide-y divide-paper-line">
            {recentExpenses.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <div className="font-medium">{e.categoryName}</div>
                  <div className="text-xs text-ink-faint">
                    {new Date(e.occurredAt).toLocaleDateString("ru-RU")} · {e.recordedByName}
                    {e.note && ` · ${e.note}`}
                  </div>
                </div>
                <span className="tabular shrink-0 font-semibold">
                  {diramToSomoniString(e.amountD)} {tg.common.somoni}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A small labelled figure, for the strips of numbers these panels are made of. */
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


// ------------------------------------------------------------------- history

/**
 * Who was paid, and when. Grouped by day, newest first, each row linking to its receipt.
 * The cashier has to be able to answer "who did we pay today?" without the owner asking
 * the database.
 */
function PaymentHistory({ history }: { history: PaidRow[] }) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const bucket = (iso: string) => {
    const at = new Date(iso);
    if (at >= startOfToday) return tg.cash.today;
    if (at >= startOfYesterday) return tg.cash.yesterday;
    return at.toLocaleDateString("ru-RU");
  };

  const groups: { label: string; rows: PaidRow[] }[] = [];
  for (const row of history) {
    const label = bucket(row.paidAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }

  return (
    <section className="card overflow-x-auto p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink-soft">{tg.cash.history}</h2>
      {groups.map((group) => {
        const total = group.rows
          .filter((r) => !r.reversed)
          .reduce((n, r) => n + r.cashPayableD, 0);
        return (
          <div key={group.label} className="mb-4 last:mb-0">
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-sm font-medium">{group.label}</h3>
              <span className="tabular text-sm font-semibold">
                {diramToSomoniString(total)} {tg.common.somoni}
              </span>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-paper-line">
                {group.rows.map((r) => (
                  <tr key={r.paymentId} className={r.reversed ? "text-ink-faint line-through" : ""}>
                    <td className="py-1.5 tabular text-ink-faint">
                      {new Date(r.paidAt).toLocaleTimeString("ru-RU", {
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="py-1.5 font-medium">{r.farm}</td>
                    <td className="py-1.5 font-mono text-xs text-brand">{r.serial}</td>
                    <td className="py-1.5 text-end tabular text-ink-soft">
                      {gramsToKgString(r.payableG, 1)} {tg.common.kg}
                    </td>
                    {/* What was recovered against an advance never left the drawer. */}
                    <td className="py-1.5 text-end tabular text-warn">
                      {r.advanceOffsetD > 0 ? `− ${diramToSomoniString(r.advanceOffsetD)}` : ""}
                    </td>
                    <td className="py-1.5 text-end tabular font-semibold">
                      {diramToSomoniString(r.cashPayableD)}
                    </td>
                    <td className="py-1.5 text-end">
                      <a href={`/pardokht/${r.paymentId}`} className="text-brand hover:underline">
                        {tg.cash.receipt}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}

/**
 * Choosing which farm is at the window.
 *
 * Farms with cotton the lab has cleared come first — they are the ones that can be paid
 * today. Each line carries the three numbers the cashier will be asked about before the
 * farmer has finished talking: what is in our shed, what of it can be sold now, and what
 * stands between us — their қарз, or our unpaid balance to them.
 */
function FarmChooser({
  farms, query, advanceRateDPerKg, readOnly, onPick,
}: {
  farms: FarmRow[];
  query: string;
  advanceRateDPerKg: number;
  readOnly?: boolean;
  onPick: (id: string) => void;
}) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // The РМА is how a farm is found — however the number was written on the paper the
    // cashier is reading it off. docs/domain.md §6.
    const digits = normaliseTin(query);
    const matched = q
      ? farms.filter(
          (f) =>
            (digits.length > 0 && (f.tin ?? "").includes(digits)) ||
            f.name.toLowerCase().includes(q) ||
            (f.phone ?? "").includes(q),
        )
      : farms;

    // Anyone the desk can actually deal with today, first.
    return [...matched].sort((a, b) => {
      const weight = (f: FarmRow) =>
        (f.readyTickets > 0 ? 4 : 0) + (f.owedD > 0 ? 2 : 0) + (f.inHandG > 0 ? 1 : 0);
      return weight(b) - weight(a) || a.name.localeCompare(b.name);
    });
  }, [farms, query]);

  const dealable = filtered.filter((f) => f.readyTickets > 0 || f.owedD > 0 || f.inHandG > 0);
  const rest = filtered.filter((f) => !dealable.includes(f));

  if (filtered.length === 0) {
    return (
      <div className="card p-8 text-center text-ink-faint">{tg.common.noResults}</div>
    );
  }

  return (
    <div className="space-y-2">
      {dealable.map((f) => (
        <button
          key={f.id}
          type="button"
          disabled={readOnly}
          onClick={() => onPick(f.id)}
          className="card flex w-full flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-start transition-colors hover:border-brand/40 hover:bg-paper disabled:opacity-60"
        >
          <div className="min-w-44 flex-1">
            <div className="font-semibold">{f.name}</div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-faint">
              <span className="tabular">{f.tin ?? "—"}</span>
              {f.phone && <span className="tabular">{f.phone}</span>}
            </div>
          </div>

          <Figure
            label={tg.cash.cottonInHand}
            value={f.inHandG > 0 ? `${gramsToKgString(f.inHandG, 0)} ${tg.common.kg}` : "—"}
          />
          <Figure
            label={tg.cash.readyToSettle}
            value={f.readyG > 0 ? `${gramsToKgString(f.readyG, 0)} ${tg.common.kg}` : "—"}
            tone={f.readyG > 0 ? "brand" : undefined}
          />
          <Figure
            label={tg.advance.outstanding}
            value={f.advanceD > 0 ? diramToSomoniString(f.advanceD) : "—"}
            tone={f.advanceD > 0 ? "warn" : undefined}
          />
          <Figure
            label={tg.cash.canBorrowNow}
            value={f.headroomD > 0 ? diramToSomoniString(f.headroomD) : "—"}
          />
          <Figure
            label={tg.cash.weOweFarm}
            value={f.owedD > 0 ? diramToSomoniString(f.owedD) : "—"}
            tone={f.owedD > 0 ? "warn" : undefined}
          />
        </button>
      ))}

      {/* Farms with nothing going on are kept, because one of them is about to deliver —
          but they are not put in front of the farms standing at the window. */}
      {rest.length > 0 && (
        <details className="card px-4 py-3">
          <summary className="cursor-pointer text-sm text-ink-soft">
            {tg.account.totalFarms} — {rest.length}
          </summary>
          <ul className="mt-2 divide-y divide-paper-line text-sm">
            {rest.map((f) => (
              <li key={f.id} className="py-1.5">
                <button type="button" disabled={readOnly} onClick={() => onPick(f.id)}
                        className="text-start hover:text-brand disabled:opacity-60">
                  {f.name}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="px-1 text-xs text-ink-faint">
        {tg.cash.lendingRate} {diramToSomoniString(advanceRateDPerKg)} {tg.common.somoni} ·{" "}
        {tg.cash.lendingLimitHint}
      </p>
    </div>
  );
}
