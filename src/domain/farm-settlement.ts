import { DomainError } from "./units";
import { settleTicket } from "./settlement";

/**
 * Ҳисоббаробаркунӣ барои хоҷагӣ — settling enough борхатҳо to cover an amount asked for.
 *
 * A farm delivers four or five loads and comes in once, months later, asking for a number
 * — «6 000 сомонӣ мехоҳам» — not for a particular борхат. This decides which tickets that
 * means, and it is a pure function so the figure the cashier reads on screen is computed
 * by the same code that will post it. docs/domain.md §4.
 *
 * Three rules do the work:
 *
 * **Money already owed is spent first.** A farm that settled last month and left 24 000
 * сомонӣ on its account, and now asks for 6 000, needs no cotton sold at all — it is
 * simply collecting. Settling a борхат anyway would lock today's price onto ten tonnes
 * for no reason, and if the price rose next week the farm would have lost that for
 * nothing. Cotton is only sold when the balance cannot cover what was asked for.
 *
 * **Oldest first.** The order the cotton came in is the only order nobody has to argue
 * about, and it matches how the cotton itself leaves the shed.
 *
 * **Whole tickets only.** A борхат is one ticket, one lab result, one price, one
 * settlement — half of one is not a thing that exists. So the last ticket taken usually
 * overshoots the amount asked for, and the overshoot stays on the farm's balance rather
 * than being handed over or refused.
 */
export interface SettlementCandidate {
  ticketId: string;
  serial: string;
  /** Oldest first is the caller's job; this is what decides it. */
  weighedAt: number;
  netG: number;
  deductionBp: number;
  /** Today's price for this ticket's variety, diram per kg. */
  priceDPerKg: number;
}

export interface PlannedTicket {
  ticketId: string;
  serial: string;
  netG: number;
  deductionBp: number;
  payableG: number;
  priceDPerKg: number;
  grossAmountD: number;
  advanceOffsetD: number;
  cashPayableD: number;
}

export interface FarmSettlementPlan {
  /** Taken from what the factory already owes this farm — no cotton sold. */
  fromBalanceD: number;
  /** What the farm is owed before this payment. */
  existingBalanceD: number;
  /** The борхатҳо that would be settled, oldest first. Empty when the balance covers it. */
  tickets: PlannedTicket[];
  grossAmountD: number;
  /** Advance recovered across the whole plan. */
  advanceOffsetD: number;
  /** What the farm is owed once these are settled, before anything is handed over. */
  cashPayableD: number;
  /** Cash that would actually be handed over now — balance and new settlements together. */
  disburseD: number;
  /** Settled beyond what was asked for; stays on the farm's balance. */
  remainderD: number;
  /** How far short everything in hand falls of the amount asked for. 0 when it covers it. */
  shortfallD: number;
  advanceRemainingD: number;
}

/**
 * @param requestedCashD What the farm asked for, diram. Pass `null` to settle everything
 *        in hand — the farm that says «ҳамаашро мехоҳам».
 */
export function planFarmSettlement(args: {
  candidates: SettlementCandidate[];
  requestedCashD: number | null;
  outstandingAdvanceD: number;
  /** What the factory already owes this farm from earlier settlements. */
  existingBalanceD?: number;
}): FarmSettlementPlan {
  const { requestedCashD } = args;
  if (requestedCashD !== null && (!Number.isSafeInteger(requestedCashD) || requestedCashD < 0)) {
    throw new DomainError("Маблағи дархостшуда нодуруст аст. / The requested amount is not valid.");
  }

  const existingBalanceD = Math.max(0, args.existingBalanceD ?? 0);
  // Spend what we already owe before selling anything. `null` — "settle everything" — is
  // a deliberate instruction to sell the lot, so it does not stop at the balance.
  const fromBalanceD =
    requestedCashD === null ? existingBalanceD : Math.min(requestedCashD, existingBalanceD);
  const stillNeededD = requestedCashD === null ? null : requestedCashD - fromBalanceD;

  const ordered = [...args.candidates].sort((a, b) => a.weighedAt - b.weighedAt);

  const tickets: PlannedTicket[] = [];
  let advanceRemaining = args.outstandingAdvanceD;
  let grossAmountD = 0;
  let advanceOffsetD = 0;
  let cashPayableD = 0;

  for (const c of ordered) {
    // Enough already: stop before taking a ticket the farm did not need to sell today.
    if (stillNeededD !== null && cashPayableD >= stillNeededD) break;

    // The same settlement function the server posts with, applied one ticket at a time so
    // the advance is recovered across the run exactly as it will be in the ledger.
    const s = settleTicket({
      netG: c.netG,
      deductionBp: c.deductionBp,
      priceDPerKg: c.priceDPerKg,
      outstandingAdvanceD: advanceRemaining,
    });

    tickets.push({
      ticketId: c.ticketId,
      serial: c.serial,
      netG: c.netG,
      deductionBp: c.deductionBp,
      payableG: s.payableG,
      priceDPerKg: s.priceDPerKg,
      grossAmountD: s.grossAmountD,
      advanceOffsetD: s.advanceOffsetD,
      cashPayableD: s.cashPayableD,
    });

    grossAmountD += s.grossAmountD;
    advanceOffsetD += s.advanceOffsetD;
    cashPayableD += s.cashPayableD;
    advanceRemaining = s.remainingAdvanceD;
  }

  // Everything the farm could take away today: what it was already owed plus what these
  // settlements come to.
  const availableD = fromBalanceD + cashPayableD;
  const wanted = requestedCashD ?? availableD;
  const disburseD = Math.min(wanted, availableD);

  return {
    fromBalanceD,
    existingBalanceD,
    tickets,
    grossAmountD,
    advanceOffsetD,
    cashPayableD,
    disburseD,
    // What stays on the farm's account afterwards: the part of the balance it did not
    // take, plus whatever the last ticket settled beyond what was asked for.
    remainderD: existingBalanceD + cashPayableD - disburseD,
    shortfallD: Math.max(0, wanted - availableD),
    advanceRemainingD: advanceRemaining,
  };
}
