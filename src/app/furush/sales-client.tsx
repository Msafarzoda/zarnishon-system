"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { submit } from "@/lib/offline/station-client";
import {
  diramToSomoniString,
  gramsToKgString,
  kgStringToGrams,
  somoniStringToDiram,
} from "@/domain/units";
import { bulkNetG, isBulk, saleAmountD, type ProductKind } from "@/domain/product";
import { useWeighbridge } from "@/lib/scale/use-weighbridge";
import { tgProduct, tgProductHint } from "@/lib/i18n/products";
import { tg } from "@/lib/i18n/tg";
import { Notice, Section, Stat, TBody, Td, Th } from "@/components/ui";

interface Buyer {
  id: string; name: string; kind: string; tin: string | null; phone: string | null; owesD: number;
}
interface SaleRow {
  id: string; invoiceNo: string; product: string; weightG: number; priceDPerKg: number;
  amountD: number; paid: boolean; soldAt: string; buyer: string; seller: string | null;
  baleCount: number; reversed: boolean;
}
type Stock = Record<string, { weightG: number; count: number }>;

const PRODUCTS: ProductKind[] = ["chigit", "kip", "ulyuk", "puchoq"];

export function SalesClient({
  prices, stock, buyers, recent, cashOnHandD, owedToUsD, readOnly, canReceive,
}: {
  prices: Record<string, number | null>;
  stock: Stock;
  buyers: Buyer[];
  recent: SaleRow[];
  cashOnHandD: number;
  owedToUsD: number;
  readOnly: boolean;
  canReceive: boolean;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [selling, setSelling] = useState<ProductKind | null>(null);
  const [receivingFrom, setReceivingFrom] = useState<Buyer | null>(null);

  const debtors = buyers.filter((b) => b.owesD > 0).sort((a, b) => b.owesD - a.owesD);

  return (
    <div className="space-y-5">
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          accent
          label={tg.cash.cashOnHand}
          value={diramToSomoniString(cashOnHandD)}
          unit={tg.common.somoni}
          hint={tg.sales.subtitle}
        />
        <Stat
          label={tg.sales.owedByBuyers}
          value={diramToSomoniString(owedToUsD)}
          unit={tg.common.somoni}
          tone={owedToUsD > 0 ? "warn" : undefined}
          hint={debtors.length > 0 ? `${debtors.length} × ${tg.sales.buyer}` : undefined}
        />
        <Stat
          label={`${tgProduct.kip} — ${tg.bales.inStock}`}
          value={String(stock.kip?.count ?? 0)}
          hint={`${gramsToKgString(stock.kip?.weightG ?? 0, 0)} ${tg.common.kg}`}
        />
        <Stat
          label={`${tgProduct.chigit} — ${tg.sales.stock}`}
          value={gramsToKgString(Math.max(0, stock.chigit?.weightG ?? 0), 0)}
          unit={tg.common.kg}
        />
      </div>

      {/* Пул қабул кардан comes first when somebody owes us — that is the one thing on
          this screen with a person standing at the window waiting for it. */}
      {debtors.length > 0 && (
        <Section title={tg.sales.owedByBuyers} tone="warn">
          <ul className="space-y-2">
            {debtors.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-white px-3 py-2"
              >
                <span className="min-w-40 flex-1 font-medium">{b.name}</span>
                {b.phone && <span className="tabular text-xs text-ink-faint">{b.phone}</span>}
                <span className="tabular text-lg font-bold text-warn">
                  {diramToSomoniString(b.owesD)} {tg.common.somoni}
                </span>
                {canReceive && (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => { setReceivingFrom(b); setSelling(null); }}
                  >
                    {tg.sales.receivePayment}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {receivingFrom && canReceive && (
        <ReceiptPanel
          buyer={receivingFrom}
          onCancel={() => setReceivingFrom(null)}
          onNotice={setNotice}
          onDone={() => { setReceivingFrom(null); router.refresh(); }}
        />
      )}

      {!readOnly && (
        <Section title={tg.sales.sell} subtitle={tg.sales.setPrices}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {PRODUCTS.map((p) => {
              const price = prices[p] ?? null;
              const have = p === "kip"
                ? `${stock.kip?.count ?? 0} × ${tgProduct.kip}`
                : `${gramsToKgString(Math.max(0, stock[p]?.weightG ?? 0), 0)} ${tg.common.kg}`;
              return (
                <button
                  key={p}
                  type="button"
                  disabled={price === null}
                  onClick={() => { setSelling(selling === p ? null : p); setReceivingFrom(null); }}
                  title={price === null ? tg.sales.priceNotSet : undefined}
                  className={`card px-4 py-3 text-start transition ${
                    selling === p ? "border-brand bg-brand-light" : "hover:bg-paper"
                  } disabled:opacity-50`}
                >
                  <div className="font-semibold">{tgProduct[p]}</div>
                  <div className="text-xs text-ink-faint">{tgProductHint[p]}</div>
                  <div className="mt-2 tabular text-lg font-bold">
                    {price === null
                      ? <span className="text-sm font-medium text-warn">{tg.sales.noPriceYet}</span>
                      : <>{diramToSomoniString(price)} <span className="text-xs font-normal text-ink-soft">{tg.common.somoni}/{tg.common.kg}</span></>}
                  </div>
                  <div className="mt-1 tabular text-xs text-ink-soft">{tg.sales.stock}: {have}</div>
                </button>
              );
            })}
          </div>
        </Section>
      )}

      {selling && !readOnly && (
        selling === "kip" ? (
          <KipSalePanel
            priceDPerKg={prices.kip!}
            buyers={buyers}
            onCancel={() => setSelling(null)}
            onNotice={setNotice}
            onDone={() => { setSelling(null); router.refresh(); }}
          />
        ) : (
          <BulkSalePanel
            product={selling}
            priceDPerKg={prices[selling]!}
            buyers={buyers}
            onCancel={() => setSelling(null)}
            onNotice={setNotice}
            onDone={() => { setSelling(null); router.refresh(); }}
          />
        )
      )}

      {recent.length > 0 && <SalesHistory rows={recent} />}
    </div>
  );
}

// ---------------------------------------------------------------- shared bits

function BuyerPicker({
  buyers, value, onChange,
}: { buyers: Buyer[]; value: string; onChange: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return buyers.slice(0, 12);
    return buyers
      .filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          (b.tin ?? "").includes(q) ||
          (b.phone ?? "").includes(q),
      )
      .slice(0, 12);
  }, [buyers, query]);

  const chosen = buyers.find((b) => b.id === value);
  if (chosen) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-brand bg-brand-light px-3 py-2">
        <span className="font-semibold">{chosen.name}</span>
        {chosen.owesD > 0 && (
          <span className="badge bg-amber-100 text-warn">
            {tg.sales.owedByBuyers}: {diramToSomoniString(chosen.owesD)}
          </span>
        )}
        <button type="button" className="btn-ghost ms-auto" onClick={() => onChange("")}>
          {tg.common.edit}
        </button>
      </div>
    );
  }

  return (
    <div>
      <input
        className="input"
        placeholder={tg.sales.chooseBuyer}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <ul className="mt-2 max-h-52 space-y-1 overflow-y-auto">
        {shown.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              className="w-full rounded-lg px-3 py-2 text-start hover:bg-paper"
              onClick={() => onChange(b.id)}
            >
              <span className="font-medium">{b.name}</span>
              {b.tin && <span className="ms-2 tabular text-xs text-ink-faint">{b.tin}</span>}
              {b.owesD > 0 && (
                <span className="ms-2 tabular text-xs text-warn">
                  {diramToSomoniString(b.owesD)} {tg.common.somoni}
                </span>
              )}
            </button>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="px-3 py-2 text-sm text-ink-faint">{tg.common.nothingFound}</li>
        )}
      </ul>
    </div>
  );
}

/**
 * One weight, taken from the indicator if it is streaming and typed with a reason if it
 * is not. Кип never uses this — a trailer of bales is the sum of what was scanned onto it.
 */
function ScaleWeightField({
  label, kg, onKg, onCapture, live, settled,
}: {
  label: string;
  kg: string;
  onKg: (v: string) => void;
  onCapture: () => void;
  live: number | null;
  settled: boolean;
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex items-center gap-2">
        <input
          className="input tabular text-2xl"
          inputMode="decimal"
          value={kg}
          onChange={(e) => onKg(e.target.value)}
        />
        <span className="text-ink-soft">{tg.common.kg}</span>
        {live !== null && (
          <button
            type="button"
            className={settled ? "btn-primary" : "btn-secondary"}
            onClick={onCapture}
            title={settled ? undefined : tg.scale.unstable}
          >
            {gramsToKgString(live, 1)}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bulk

function BulkSalePanel({
  product, priceDPerKg, buyers, onCancel, onNotice, onDone,
}: {
  product: ProductKind;
  priceDPerKg: number;
  buyers: Buyer[];
  onCancel: () => void;
  onNotice: (n: { tone: "ok" | "warn" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const scale = useWeighbridge();
  const [buyerId, setBuyerId] = useState("");
  const [tareKg, setTareKg] = useState("");
  const [grossKg, setGrossKg] = useState("");
  const [tareRaw, setTareRaw] = useState<string | null>(null);
  const [grossRaw, setGrossRaw] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [paidNow, setPaidNow] = useState("");
  const [busy, setBusy] = useState(false);

  const live = scale.reading?.weightG ?? null;
  const lastFrame = scale.frames[scale.frames.length - 1] ?? null;

  // Both numbers, and what the sale is worth, recomputed as they are typed. The operator
  // should never press Фурӯхтан to find out what he is about to record.
  let netG: number | null = null;
  let error: string | null = null;
  try {
    if (tareKg.trim() && grossKg.trim()) {
      netG = bulkNetG(kgStringToGrams(tareKg), kgStringToGrams(grossKg));
    }
  } catch (err) {
    error = err instanceof Error ? err.message.split(" / ")[0]! : tg.common.error;
  }
  const amountD = netG === null ? null : saleAmountD(netG, priceDPerKg);

  // A weight the indicator gave us needs no written reason; one that was typed does.
  const typed = tareRaw === null || grossRaw === null;

  async function sell() {
    if (!buyerId || netG === null || amountD === null) return;
    setBusy(true);
    const out = await submit<{ invoiceNo: string; amountD: number }>("/api/sales", {
      product,
      buyerId,
      tareG: kgStringToGrams(tareKg),
      grossG: kgStringToGrams(grossKg),
      tareSource: tareRaw ? "indicator" : "manual",
      grossSource: grossRaw ? "indicator" : "manual",
      tareRaw: tareRaw ?? undefined,
      grossRaw: grossRaw ?? undefined,
      weighReason: typed ? reason.trim() : undefined,
      paidNowD: paidNow.trim() ? somoniStringToDiram(paidNow) : undefined,
    });
    setBusy(false);
    if (out.kind === "rejected") onNotice({ tone: "bad", text: out.message });
    else {
      onNotice({
        tone: "ok",
        text: out.kind === "applied"
          ? `${tg.sales.sold} — ${out.result.invoiceNo}, ${diramToSomoniString(out.result.amountD)} ${tg.common.somoni}`
          : tg.app.pendingSync,
      });
      onDone();
    }
  }

  return (
    <Section
      title={`${tg.sales.sell} — ${tgProduct[product]}`}
      subtitle={`${tg.sales.price}: ${diramToSomoniString(priceDPerKg)} ${tg.common.somoni}`}
      actions={<button type="button" className="btn-ghost" onClick={onCancel}>{tg.common.cancel}</button>}
    >
      <div className="space-y-4">
        <div>
          <span className="label">{tg.sales.buyer}</span>
          <BuyerPicker buyers={buyers} value={buyerId} onChange={setBuyerId} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Тара first, and брутто second, because that is the order the lorry is
              actually weighed in — it arrives empty to collect. Intake is the other way
              round and putting the fields in the intake order would have the operator
              weighing a full lorry as тара. */}
          <ScaleWeightField
            label={tg.sales.tare}
            kg={tareKg}
            onKg={(v) => { setTareKg(v); setTareRaw(null); }}
            live={live}
            settled={scale.settled}
            onCapture={() => {
              if (live === null) return;
              setTareKg(gramsToKgString(live, 1));
              setTareRaw(lastFrame);
            }}
          />
          <ScaleWeightField
            label={tg.sales.gross}
            kg={grossKg}
            onKg={(v) => { setGrossKg(v); setGrossRaw(null); }}
            live={live}
            settled={scale.settled}
            onCapture={() => {
              if (live === null) return;
              setGrossKg(gramsToKgString(live, 1));
              setGrossRaw(lastFrame);
            }}
          />
        </div>

        {typed && (
          <label className="block">
            <span className="label">{tg.production.reasonNeeded}</span>
            <input
              className="input"
              placeholder={tg.production.reasonPlaceholder}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}

        {error && <Notice tone="bad">{error}</Notice>}

        {netG !== null && amountD !== null && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label={tg.sales.net} value={gramsToKgString(netG, 1)} unit={tg.common.kg} />
            <Stat
              accent size="lg"
              label={tg.sales.amount}
              value={diramToSomoniString(amountD)}
              unit={tg.common.somoni}
            />
          </div>
        )}

        <label className="block">
          <span className="label">{tg.sales.paidNow}</span>
          <input
            className="input tabular"
            inputMode="decimal"
            placeholder={amountD !== null ? diramToSomoniString(amountD) : ""}
            value={paidNow}
            onChange={(e) => setPaidNow(e.target.value)}
          />
          <span className="mt-1 block text-xs text-ink-faint">{tg.sales.paidNowHint}</span>
        </label>

        <button
          type="button"
          className="btn-primary"
          disabled={busy || !buyerId || netG === null || (typed && !reason.trim())}
          onClick={sell}
        >
          {tg.sales.sell}
        </button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- кип

interface ScannedRow { id: string; serial: string; weightG: number; batchNumber: number | null }

/**
 * Loading a lorry with кип.
 *
 * The scanned list lives in the browser until the lorry is full, and is mirrored into
 * `localStorage` on every scan. Loading a trailer takes an hour and two hundred bales; a
 * page reload, a flat tablet or a knocked cable partway through must not mean starting
 * again, because a loading bay that loses its list once will be kept on paper for ever.
 *
 * Each scan is checked against the server as it happens — is it ours, is it in stock, is
 * it already on somebody else's invoice — so a refusal comes while the bale is still in
 * the operator's hands, not at the end when the lorry is full.
 */
function KipSalePanel({
  priceDPerKg, buyers, onCancel, onNotice, onDone,
}: {
  priceDPerKg: number;
  buyers: Buyer[];
  onCancel: () => void;
  onNotice: (n: { tone: "ok" | "warn" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const STORE_KEY = "zarnishon.kip-loading";
  const [buyerId, setBuyerId] = useState("");
  const [scanned, setScanned] = useState<ScannedRow[]>([]);
  const [input, setInput] = useState("");
  const [scanNotice, setScanNotice] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [paidNow, setPaidNow] = useState("");
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const boxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORE_KEY);
      if (saved) setScanned(JSON.parse(saved) as ScannedRow[]);
    } catch {
      // A browser with storage blocked simply gets no recovery, not a broken screen.
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(scanned));
    } catch {
      /* nothing to do; the list still works for this session */
    }
  }, [scanned, restored]);

  const totalG = scanned.reduce((sum, b) => sum + b.weightG, 0);
  const amountD = saleAmountD(totalG, priceDPerKg);

  async function scan(serial: string) {
    const text = serial.trim();
    if (!text) return;
    setInput("");
    if (scanned.some((b) => b.serial.toUpperCase() === text.toUpperCase())) {
      setScanNotice({ tone: "warn", text: `${text} — ${tg.bales.alreadyScanned}` });
      return;
    }
    try {
      const res = await fetch(`/api/bales/lookup?serial=${encodeURIComponent(text)}`);
      const body = (await res.json()) as
        | { found: false; reason: string }
        | { found: true; bale: ScannedRow & { refusal: string | null } };
      if (!body.found) {
        setScanNotice({
          tone: "bad",
          text: body.reason === "NOT_OURS" ? tg.bales.notOurs : tg.bales.unknown,
        });
        return;
      }
      if (body.bale.refusal) {
        setScanNotice({ tone: "bad", text: `${body.bale.serial} — ${body.bale.refusal}` });
        return;
      }
      setScanned((s) => [
        ...s,
        {
          id: body.bale.id,
          serial: body.bale.serial,
          weightG: body.bale.weightG,
          batchNumber: body.bale.batchNumber,
        },
      ]);
      setScanNotice({
        tone: "ok",
        text: `${body.bale.serial} — ${gramsToKgString(body.bale.weightG, 1)} ${tg.common.kg}`,
      });
    } catch {
      setScanNotice({ tone: "bad", text: tg.common.error });
    } finally {
      boxRef.current?.focus();
    }
  }

  async function sell() {
    if (!buyerId || scanned.length === 0) return;
    setBusy(true);
    const out = await submit<{ invoiceNo: string; amountD: number }>("/api/sales", {
      product: "kip",
      buyerId,
      baleIds: scanned.map((b) => b.id),
      paidNowD: paidNow.trim() ? somoniStringToDiram(paidNow) : undefined,
    });
    setBusy(false);
    if (out.kind === "rejected") {
      onNotice({ tone: "bad", text: out.message });
      return;
    }
    // Only now is the list safe to drop: the bales are on an invoice.
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch {
      /* nothing to do */
    }
    setScanned([]);
    onNotice({
      tone: "ok",
      text: out.kind === "applied"
        ? `${tg.sales.sold} — ${out.result.invoiceNo}, ${diramToSomoniString(out.result.amountD)} ${tg.common.somoni}`
        : tg.app.pendingSync,
    });
    onDone();
  }

  return (
    <Section
      title={`${tg.sales.sell} — ${tgProduct.kip}`}
      subtitle={`${tg.sales.price}: ${diramToSomoniString(priceDPerKg)} ${tg.common.somoni}`}
      actions={<button type="button" className="btn-ghost" onClick={onCancel}>{tg.common.cancel}</button>}
    >
      <div className="space-y-4">
        <div>
          <span className="label">{tg.sales.buyer}</span>
          <BuyerPicker buyers={buyers} value={buyerId} onChange={setBuyerId} />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Stat accent label={tg.bales.scanned} value={String(scanned.length)} />
          <Stat label={tg.sales.net} value={gramsToKgString(totalG, 1)} unit={tg.common.kg} />
          <Stat
            size="lg"
            label={tg.sales.amount}
            value={diramToSomoniString(amountD)}
            unit={tg.common.somoni}
          />
        </div>

        {/*
          * A hand scanner types the serial and then sends Enter, so Enter has to add the
          * bale — and it must not depend on the browser's implicit form submission, which
          * a form with no submit button does not reliably do. Both are wired: an explicit
          * submit button, and Enter handled on the field itself. Two hundred bales go
          * through here in an hour and the operator never touches the mouse.
          */}
        <form onSubmit={(e) => { e.preventDefault(); void scan(input); }}>
          <span className="label">{tg.bales.scanHere}</span>
          <div className="flex gap-2">
            <input
              ref={boxRef}
              className="input flex-1 font-mono text-lg"
              placeholder="K-2026-101-00042"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void scan(input);
                }
              }}
              autoFocus
            />
            <button type="submit" className="btn-secondary" disabled={!input.trim()}>
              {tg.common.add}
            </button>
          </div>
        </form>

        {scanNotice && <Notice tone={scanNotice.tone}>{scanNotice.text}</Notice>}

        {scanned.length > 0 && (
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>№</Th>
                  <Th>{tg.bales.serial}</Th>
                  <Th>{tg.ticket.batch}</Th>
                  <Th align="end">{tg.common.weight}</Th>
                  <Th />
                </tr>
              </thead>
              <TBody>
                {/* Newest first: the operator checks the bale he just scanned, and it
                    should be under his eyes rather than at the bottom of two hundred. */}
                {[...scanned].reverse().map((b, i) => (
                  <tr key={b.id}>
                    <Td numeric className="text-ink-faint">{scanned.length - i}</Td>
                    <Td className="font-mono text-brand">{b.serial}</Td>
                    <Td numeric>{b.batchNumber ?? "—"}</Td>
                    <Td align="end" numeric>{gramsToKgString(b.weightG, 1)}</Td>
                    <Td align="end">
                      <button
                        type="button"
                        className="btn-ghost text-alarm"
                        onClick={() => setScanned((s) => s.filter((x) => x.id !== b.id))}
                      >
                        {tg.bales.removeFromList}
                      </button>
                    </Td>
                  </tr>
                ))}
              </TBody>
            </table>
          </div>
        )}

        <label className="block">
          <span className="label">{tg.sales.paidNow}</span>
          <input
            className="input tabular"
            inputMode="decimal"
            placeholder={diramToSomoniString(amountD)}
            value={paidNow}
            onChange={(e) => setPaidNow(e.target.value)}
          />
          <span className="mt-1 block text-xs text-ink-faint">{tg.sales.paidNowHint}</span>
        </label>

        <button
          type="button"
          className="btn-primary"
          disabled={busy || !buyerId || scanned.length === 0}
          onClick={sell}
        >
          {tg.sales.sell} — {scanned.length} × {tgProduct.kip}
        </button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- receipts

function ReceiptPanel({
  buyer, onCancel, onNotice, onDone,
}: {
  buyer: Buyer;
  onCancel: () => void;
  onNotice: (n: { tone: "ok" | "warn" | "bad"; text: string }) => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(diramToSomoniString(buyer.owesD));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  let amountD = 0;
  let error: string | null = null;
  try {
    amountD = somoniStringToDiram(amount);
    if (amountD > buyer.owesD) {
      error = `${tg.sales.owedByBuyers}: ${diramToSomoniString(buyer.owesD)} ${tg.common.somoni}`;
    }
  } catch {
    error = tg.common.error;
  }

  async function receive() {
    setBusy(true);
    const out = await submit<{ receiptNo: string; balanceAfterD: number }>(
      "/api/sales/receipts",
      { buyerId: buyer.id, amountD, note: note.trim() || undefined },
    );
    setBusy(false);
    if (out.kind === "rejected") onNotice({ tone: "bad", text: out.message });
    else {
      onNotice({
        tone: "ok",
        text: out.kind === "applied"
          ? `${tg.sales.receipt} ${out.result.receiptNo} — ${diramToSomoniString(amountD)} ${tg.common.somoni}`
          : tg.app.pendingSync,
      });
      onDone();
    }
  }

  return (
    <Section
      title={`${tg.sales.receivedFrom} ${buyer.name}`}
      actions={<button type="button" className="btn-ghost" onClick={onCancel}>{tg.common.cancel}</button>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">{tg.sales.amount}</span>
          <input
            className="input tabular text-2xl"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
        </label>
        <label className="block">
          <span className="label">{tg.common.note}</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <button
        type="button"
        className="btn-primary mt-4"
        disabled={busy || amountD <= 0 || error !== null}
        onClick={receive}
      >
        {tg.sales.receivePayment}
      </button>
    </Section>
  );
}

function SalesHistory({ rows }: { rows: SaleRow[] }) {
  return (
    <Section title={tg.sales.recent} scroll>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th>{tg.sales.invoice}</Th>
            <Th>{tg.sales.product}</Th>
            <Th>{tg.sales.buyer}</Th>
            <Th align="end">{tg.common.weight}</Th>
            <Th align="end">{tg.sales.price}</Th>
            <Th align="end">{tg.sales.amount}</Th>
            <Th>{tg.bales.state}</Th>
            <Th align="end">{tg.common.date}</Th>
          </tr>
        </thead>
        <TBody>
          {rows.map((r) => (
            <tr key={r.id} className={r.reversed ? "opacity-50 line-through" : ""}>
              <Td className="font-mono text-brand">{r.invoiceNo}</Td>
              <Td>
                {tgProduct[r.product as ProductKind]}
                {r.baleCount > 0 && (
                  <span className="ms-1 text-xs text-ink-faint">× {r.baleCount}</span>
                )}
              </Td>
              <Td>{r.buyer}</Td>
              <Td align="end" numeric>{gramsToKgString(r.weightG, 1)}</Td>
              <Td align="end" numeric className="text-ink-soft">
                {diramToSomoniString(r.priceDPerKg)}
              </Td>
              <Td align="end" numeric className="font-semibold">
                {diramToSomoniString(r.amountD)}
              </Td>
              <Td>
                <span className={`badge ${r.paid ? "bg-brand text-white" : "bg-amber-100 text-warn"}`}>
                  {r.paid ? tg.sales.sold : tg.sales.onCredit}
                </span>
              </Td>
              <Td align="end" numeric className="text-ink-faint">
                {new Date(r.soldAt).toLocaleDateString("ru-RU", {
                  day: "2-digit", month: "2-digit",
                })}
              </Td>
            </tr>
          ))}
        </TBody>
      </table>
    </Section>
  );
}
