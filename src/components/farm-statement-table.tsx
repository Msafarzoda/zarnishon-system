import {
  bpToPercentString,
  diramToSomoniString,
  gramsToKgString,
} from "@/domain/units";
import type { StatementRow } from "@/server/services/farm-statement";
import { tg } from "@/lib/i18n/tg";

/**
 * Every movement on a farm's account, in date order.
 *
 * Cotton arrives, cash goes out as an advance, and cash goes out again as payment — at
 * different times and in no fixed order. Read separately none of them answers what the
 * farm is owed; read together on one line each, they do.
 *
 * A payment row shows the price that was actually applied on that day, the advance it
 * recovered, and the cash that changed hands, all read back from the payment itself
 * rather than recomputed — a settled payment is history and must not move when the
 * price does.
 */
export function FarmStatementTable({ rows }: { rows: StatementRow[] }) {
  if (rows.length === 0) {
    return <p className="py-8 text-center text-ink-faint">{tg.account.nothingYet}</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead className="text-ink-faint">
        <tr>
          <Th>{tg.account.colDate}</Th>
          <Th>{tg.account.colOperation}</Th>
          <Th>{tg.ticket.number}</Th>
          <Th end>{tg.account.colWeight}</Th>
          <Th end>{tg.lab.deduction}</Th>
          <Th end>{tg.account.colPrice}</Th>
          <Th end>{tg.account.colAmount}</Th>
          <Th end>{tg.account.colCashOut}</Th>
          <Th end>{tg.account.colAdvance}</Th>
          <Th end>{tg.account.colBalance}</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-paper-line">
        {rows.map((r, i) => (
          <tr
            key={`${r.kind}-${r.disbursementId ?? r.paymentId ?? r.ticketId ?? i}`}
            className={r.reversed ? "text-ink-faint line-through" : ""}
          >
            <Td>{r.at.toLocaleDateString("ru-RU")}</Td>
            <Td>
              <span className={label(r.kind)}>{operation(r.kind)}</span>
              {r.note && <span className="ms-2 text-xs text-ink-faint">{r.note}</span>}
            </Td>
            <Td>
              {r.serial ? (
                <a
                  href={
                    r.disbursementId
                      ? `/pardokht/nakd/${r.disbursementId}`
                      : r.paymentId
                        ? `/pardokht/${r.paymentId}`
                        : `/borkhat/${r.ticketId}`
                  }
                  className="font-mono text-xs text-brand hover:underline"
                >
                  {r.serial}
                </a>
              ) : (
                "—"
              )}
            </Td>
            <Td end>
              {r.kind === "delivery"
                ? r.netG !== null
                  ? `${gramsToKgString(r.netG, 1)} ${tg.common.kg}`
                  : "—"
                : r.payableG !== null
                  ? `${gramsToKgString(r.payableG, 1)} ${tg.common.kg}`
                  : ""}
            </Td>
            <Td end>{r.deductionBp !== null ? `${bpToPercentString(r.deductionBp)} %` : ""}</Td>
            {/* The price is only meaningful on the day it was applied. */}
            <Td end>{r.priceDPerKg !== null ? diramToSomoniString(r.priceDPerKg) : ""}</Td>
            <Td end strong>
              {r.grossAmountD !== null ? diramToSomoniString(r.grossAmountD) : ""}
            </Td>
            {/* Cash that actually changed hands, which is not the same column as what the
                cotton was worth — a settled борхат can hand over nothing at all. */}
            <Td end>
              {r.cashD !== null ? (
                <span className="font-semibold text-brand">{diramToSomoniString(r.cashD)}</span>
              ) : (
                ""
              )}
              {r.payableBalanceD !== null && r.payableBalanceD > 0 && (
                <span className="ms-2 text-xs text-warn">
                  → {diramToSomoniString(r.payableBalanceD)}
                </span>
              )}
            </Td>
            <Td end>
              {r.advanceIssuedD ? (
                <span className="text-warn">+ {diramToSomoniString(r.advanceIssuedD)}</span>
              ) : r.advanceOffsetD ? (
                <span className="text-brand">− {diramToSomoniString(r.advanceOffsetD)}</span>
              ) : (
                ""
              )}
            </Td>
            <Td end>
              <span className={r.advanceBalanceD > 0 ? "font-medium text-warn" : "text-ink-faint"}>
                {diramToSomoniString(r.advanceBalanceD)}
              </span>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function operation(kind: StatementRow["kind"]): string {
  switch (kind) {
    case "delivery": return tg.account.opDelivery;
    case "advance": return tg.account.opAdvance;
    case "disbursement": return tg.account.opDisbursement;
    default: return tg.account.opPayment;
  }
}

function label(kind: StatementRow["kind"]): string {
  switch (kind) {
    case "delivery": return "font-medium";
    case "advance": return "font-medium text-warn";
    case "disbursement": return "font-medium text-brand";
    default: return "font-medium text-ink-soft";
  }
}

function Th({ children, end }: { children: React.ReactNode; end?: boolean }) {
  return (
    <th
      className={`whitespace-nowrap px-2 py-2 text-xs font-medium uppercase tracking-wide ${
        end ? "text-end" : "text-start"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children, end, strong,
}: { children: React.ReactNode; end?: boolean; strong?: boolean }) {
  return (
    <td
      className={`whitespace-nowrap px-2 py-2 tabular ${end ? "text-end" : "text-start"} ${
        strong ? "font-semibold" : ""
      }`}
    >
      {children}
    </td>
  );
}
