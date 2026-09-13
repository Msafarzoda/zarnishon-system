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
import { submit } from "@/lib/offline/station-client";
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
}

export function CashClient({
  cashOnHandD, priceDPerKg, priceError, tickets, farms,
}: {
  cashOnHandD: number;
  priceDPerKg: number | null;
  priceError: string | null;
  tickets: UnpaidTicket[];
  farms: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [showAdvance, setShowAdvance] = useState(false);

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
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label={tg.cash.cashOnHand} value={`${diramToSomoniString(cashOnHandD)} ${tg.common.somoni}`} />
        <Stat
          label={tg.price.current}
          value={priceDPerKg !== null
            ? `${diramToSomoniString(priceDPerKg)} ${tg.price.perKg}`
            : "—"}
          tone={priceDPerKg === null ? "bad" : undefined}
        />
        <Stat label={tg.dashboard.unpaidTickets} value={String(tickets.length)} />
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

      <div className="flex gap-2 flex-wrap">
        <input
          className="input flex-1 min-w-56"
          placeholder={tg.cash.scanTicket}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button className="btn-secondary" onClick={() => setShowAdvance((v) => !v)}>
          {tg.advance.issue}
        </button>
      </div>

      {showAdvance && (
        <AdvanceForm farms={farms} onNotice={setNotice}
                     onDone={() => { setShowAdvance(false); router.refresh(); }} />
      )}

      {selected && priceDPerKg !== null ? (
        <PaymentPanel
          ticket={selected}
          priceDPerKg={priceDPerKg}
          onCancel={() => setSelectedId(null)}
          onNotice={setNotice}
          onDone={() => { setSelectedId(null); router.refresh(); }}
        />
      ) : (
        <ul className="space-y-2">
          {filtered.length === 0 && (
            <li className="card p-8 text-center text-ink-faint">{tg.common.nothingFound}</li>
          )}
          {filtered.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => setSelectedId(t.id)}
                disabled={priceDPerKg === null}
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
                <span className="ms-auto tabular font-semibold">
                  {gramsToKgString(t.netG, 1)} {tg.common.kg}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-sm text-ink-soft">{label}</div>
      <div className={`tabular text-2xl font-bold ${tone === "bad" ? "text-alarm" : ""}`}>
        {value}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- payment

function PaymentPanel({
  ticket, priceDPerKg, onCancel, onNotice, onDone,
}: {
  ticket: UnpaidTicket;
  priceDPerKg: number;
  onCancel: () => void;
  onNotice: (n: { tone: "ok" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const [copyCollected, setCopyCollected] = useState(false);
  const [busy, setBusy] = useState(false);

  // The same pure function the server settles with, so what the cashier reads on screen
  // is what the ledger will record — not a second implementation that can drift.
  const s = settleTicket({
    netG: ticket.netG,
    deductionBp: ticket.deductionBp,
    priceDPerKg,
    outstandingAdvanceD: ticket.advanceD,
  });

  async function pay() {
    setBusy(true);
    try {
      const res = await submit<{ invoiceNo: string; cashPayableD: number }>("/api/payments", {
        ticketId: ticket.id,
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
        text: `${res.result.invoiceNo} — ${tg.cash.cashToPay} ` +
          `${diramToSomoniString(res.result.cashPayableD)} ${tg.common.somoni}`,
      });
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

      {/* The stamped Copy C is the farmer's claim. Taking it in is part of paying. */}
      <label className="flex items-start gap-3 rounded-lg border border-paper-line p-3">
        <input type="checkbox" className="mt-1" checked={copyCollected}
               onChange={(e) => setCopyCollected(e.target.checked)} />
        <span>
          <span className="font-medium">{tg.cash.collectCopy}</span>
          <span className="block text-sm text-ink-soft">{tg.cash.collectCopyHint}</span>
        </span>
      </label>

      <button onClick={pay} disabled={busy || !copyCollected} className="btn-primary btn-lg w-full">
        {busy ? tg.common.loading : tg.cash.confirmPay}
      </button>
    </div>
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

function AdvanceForm({
  farms, onNotice, onDone,
}: {
  farms: { id: string; name: string }[];
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

  return (
    <form onSubmit={onSubmit} className="card p-5 space-y-4">
      <h2 className="font-semibold">{tg.advance.issue}</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="adv-farm">{tg.ticket.consignor}</label>
          <select id="adv-farm" required className="input" value={counterpartyId}
                  onChange={(e) => setCounterpartyId(e.target.value)}>
            <option value="">—</option>
            {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="adv-amount">{tg.advance.principal}</label>
          <input id="adv-amount" inputMode="decimal" required className="input"
                 placeholder="5000" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="adv-purpose">{tg.advance.purpose}</label>
          <input id="adv-purpose" className="input" value={purpose}
                 onChange={(e) => setPurpose(e.target.value)} />
        </div>
      </div>
      <button type="submit" disabled={busy || !counterpartyId || !amount} className="btn-primary">
        {busy ? tg.common.loading : tg.advance.issue}
      </button>
    </form>
  );
}
