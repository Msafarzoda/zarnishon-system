"use client";

import { useEffect, useState } from "react";
import { diramToSomoniString, gramsToKgString } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";

export interface WorkTicket {
  id: string;
  serial: string;
  status: string;
  grossG: number | null;
  netG: number | null;
  farm: string;
  tin: string | null;
  plate: string | null;
  batchNumber: number | null;
  /** When this load last moved — what "waiting since" is measured from. */
  since: string;
}

/**
 * The line, in the order the cotton travels it.
 *
 * Three columns, one per step, each holding the loads stuck at that step and linking to
 * the screen that unsticks them. An operator doing all three jobs reads left to right and
 * knows what is left; nobody has to hold the queue in their head.
 */
export function WorkBoard({
  tickets, cashOnHandD, priceDPerKg,
  receivedTodayG, receivedToday, analysedToday, paidToday,
  canWeigh, canLab, canPay,
  canGin, openRunSerial, balesInStock, balesWeightG, bulkToSellG, buyersOweD,
}: {
  tickets: WorkTicket[];
  cashOnHandD: number;
  priceDPerKg: number | null;
  receivedTodayG: number;
  receivedToday: number;
  analysedToday: number;
  paidToday: number;
  canWeigh: boolean;
  canLab: boolean;
  canPay: boolean;
  /** §7 — whether this person works the gin floor as well as the weighbridge. */
  canGin: boolean;
  openRunSerial: string | null;
  balesInStock: number;
  balesWeightG: number;
  bulkToSellG: number;
  buyersOweD: number;
}) {
  const onScale = tickets.filter((t) => t.status === "OPEN");
  const atLab = tickets.filter((t) => t.status === "WEIGHED");
  const atCash = tickets.filter((t) => t.status === "ANALYSED");

  return (
    <div className="space-y-5">
      {/* The paper is still the record of account this season; the screen should say so
          rather than let anyone conclude the hand-written book can stop. */}
      <p className="rounded-lg border border-paper-line bg-paper px-4 py-2 text-sm text-ink-soft">
        {tg.work.paperReminder}
      </p>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={tg.cash.cashOnHand}
          value={`${diramToSomoniString(cashOnHandD)} ${tg.common.somoni}`}
        />
        <Stat
          label={tg.cash.priceToday}
          value={priceDPerKg !== null ? diramToSomoniString(priceDPerKg) : "—"}
          hint={priceDPerKg !== null ? tg.price.perKg : undefined}
        />
        <Stat
          label={tg.work.todayReceived}
          value={`${gramsToKgString(receivedTodayG, 0)} ${tg.common.kg}`}
          hint={`${receivedToday} × ${tg.cash.willSettleCount}`}
        />
        <Stat
          label={tg.work.todayPaid}
          value={String(paidToday)}
          hint={`${tg.work.todayAnalysed}: ${analysedToday}`}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <Column
          step={tg.work.stepScale}
          title={tg.work.onScale}
          action={tg.work.onScaleAction}
          href="/tarozu"
          tickets={onScale}
          enabled={canWeigh}
          tone="scale"
          weightOf={(t) => t.grossG}
        />
        <Column
          step={tg.work.stepLab}
          title={tg.work.awaitingLab}
          action={tg.work.awaitingLabAction}
          href="/laboratoriya"
          tickets={atLab}
          enabled={canLab}
          tone="lab"
          weightOf={(t) => t.netG}
        />
        <Column
          step={tg.work.stepCash}
          title={tg.work.readyToPay}
          action={tg.work.readyToPayAction}
          href="/hazina"
          tickets={atCash}
          enabled={canPay}
          tone="cash"
          weightOf={(t) => t.netG}
        />
      </section>

      {/* Корхона — what happens to the cotton after it has been paid for.
          Deliberately not a fourth column: nothing is stuck at the press waiting for
          somebody, so these are states to be read rather than queues to be cleared. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">
          {tg.work.factory}
          <span className="ms-2 font-normal normal-case text-ink-faint/80">
            {tg.work.factoryHint}
          </span>
        </h2>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FactoryTile
            label={openRunSerial ? tg.work.ginOpen : tg.work.ginClosed}
            value={openRunSerial ?? "—"}
            action={tg.work.ginAction}
            href="/istehsol"
            enabled={canGin}
            tone={openRunSerial ? undefined : "warn"}
          />
          <FactoryTile
            label={tg.bales.inStock}
            value={String(balesInStock)}
            hint={`${gramsToKgString(balesWeightG, 0)} ${tg.common.kg}`}
            action={tg.work.balesAction}
            href="/kipho"
            enabled
          />
          <FactoryTile
            label={tg.work.waitingToSell}
            value={`${gramsToKgString(bulkToSellG, 0)} ${tg.common.kg}`}
            hint={tg.sales.subtitle}
            action={tg.work.sellAction}
            href="/furush"
            enabled={canGin}
          />
          <FactoryTile
            label={tg.sales.owedByBuyers}
            value={`${diramToSomoniString(buyersOweD)} ${tg.common.somoni}`}
            action={tg.sales.receivePayment}
            href="/furush"
            enabled={canPay}
            tone={buyersOweD > 0 ? "warn" : undefined}
          />
        </div>
      </section>
    </div>
  );
}

/**
 * One fact about the factory, with the screen that acts on it attached.
 *
 * Same shape as a Stat, plus a link — because every one of these is a fact somebody is
 * about to do something about, and making them read-only would send the operator back to
 * the nav bar to find the screen they were just told they needed.
 */
function FactoryTile({
  label, value, hint, action, href, enabled, tone,
}: {
  label: string;
  value: string;
  hint?: string;
  action: string;
  href: string;
  enabled: boolean;
  tone?: "warn";
}) {
  return (
    <div className={`card flex flex-col px-4 py-3 ${tone === "warn" ? "border-warn" : ""}`}>
      <div className="text-sm text-ink-soft">{label}</div>
      <div
        className={`tabular text-2xl font-bold leading-tight ${tone === "warn" ? "text-warn" : ""}`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
      <a
        href={enabled ? href : undefined}
        aria-disabled={!enabled}
        className={`mt-3 block text-center text-sm ${
          enabled ? "btn-secondary" : "btn-secondary pointer-events-none opacity-50"
        }`}
      >
        {action}
      </a>
    </div>
  );
}

function Column({
  step, title, action, href, tickets, enabled, tone, weightOf,
}: {
  step: string;
  title: string;
  action: string;
  href: string;
  tickets: WorkTicket[];
  enabled: boolean;
  tone: "scale" | "lab" | "cash";
  weightOf: (t: WorkTicket) => number | null;
}) {
  const accent =
    tone === "scale" ? "border-brand" : tone === "lab" ? "border-warn" : "border-brand";
  const totalG = tickets.reduce((n, t) => n + (weightOf(t) ?? 0), 0);

  return (
    <section className={`card flex flex-col p-4 ${tickets.length > 0 ? accent : ""}`}>
      <header className="mb-3">
        <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">{step}</div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className="tabular text-3xl font-bold">{tickets.length}</span>
          {totalG > 0 && (
            <span className="tabular text-sm text-ink-soft">
              {gramsToKgString(totalG, 0)} {tg.common.kg}
            </span>
          )}
        </div>
        <div className="text-sm text-ink-soft">{title}</div>
      </header>

      {tickets.length === 0 ? (
        <p className="flex-1 py-6 text-center text-sm text-ink-faint">{tg.work.nothingHere}</p>
      ) : (
        <ul className="flex-1 space-y-1.5">
          {tickets.map((t) => (
            <li key={t.id}>
              <a
                href={`/borkhat/${t.id}`}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg bg-paper px-3 py-2 text-sm transition-colors hover:bg-paper-line/40"
              >
                <span className="font-mono text-xs text-brand">{t.serial.slice(-6)}</span>
                <span className="font-medium">{t.farm}</span>
                {t.plate && <span className="text-xs text-ink-faint">{t.plate}</span>}
                <span className="ms-auto flex items-baseline gap-2">
                  {weightOf(t) !== null && (
                    <span className="tabular">{gramsToKgString(weightOf(t)!, 0)}</span>
                  )}
                  <WaitingFor since={t.since} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {/* Disabled rather than hidden for a viewer without the role: the column is still
          worth reading, and an action that silently vanishes reads as a broken page. */}
      <a
        href={enabled ? href : undefined}
        aria-disabled={!enabled}
        className={`mt-3 block text-center ${
          enabled ? "btn-primary" : "btn-secondary pointer-events-none opacity-50"
        }`}
      >
        {action}
      </a>
    </section>
  );
}

/**
 * How long this load has been standing here. Measured in the browser after mounting: the
 * server renders at one moment and the browser hydrates at another, and a clock that
 * disagrees across the two makes React throw the render away.
 */
function WaitingFor({ since }: { since: string }) {
  const [hours, setHours] = useState<number | null>(null);
  useEffect(() => {
    setHours(Math.floor((Date.now() - new Date(since).getTime()) / 3_600_000));
  }, [since]);

  if (hours === null || hours < 1) return null;
  return (
    <span className={`badge ${hours >= 4 ? "bg-amber-100 text-warn" : "bg-white text-ink-faint"}`}>
      {hours} {tg.work.waitingHours}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-sm text-ink-soft">{label}</div>
      <div className="tabular text-2xl font-bold leading-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}
