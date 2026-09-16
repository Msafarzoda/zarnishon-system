import { notFound } from "next/navigation";
import { and, desc, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  batches,
  weighEvents,
  counterparties,
  drivers,
  users,
  varieties,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { requirePageRole } from "@/lib/auth/session";
import { gramsToKgString } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";
import { PrintButton } from "./print-button";
import {
  PrintCopy,
  PrintField,
  PrintFields,
  PrintIdentity,
  PrintPage,
  PrintSheet,
  PrintSignature,
  PrintSignatures,
  PrintWarning,
} from "@/components/print";

export const dynamic = "force-dynamic";

const CONSIGNEE = 'ЧДММ "ЗАРНИШОН"';

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  // The Борхат is the shared document: the guard holds one copy, the factory another.
  await requirePageRole(
    "guard", "weigher", "lab", "merchandiser", "cashier", "accountant", "owner", "admin",
  );

  const { id } = await params;

  const [t] = await db
    .select({
      id: weighTickets.id,
      serial: weighTickets.serial,
      serialNumber: weighTickets.serialNumber,
      season: weighTickets.season,
      status: weighTickets.status,
      createdAt: weighTickets.createdAt,
      weighedAt: weighTickets.weighedAt,
      grossG: weighTickets.grossG,
      tareG: weighTickets.tareG,
      netG: weighTickets.netG,
      grade: weighTickets.grade,
      cottonClass: weighTickets.cottonClass,
      loadingPlace: weighTickets.loadingPlace,
      unloadingPlace: weighTickets.unloadingPlace,
      routeNo: weighTickets.routeNo,
      farm: counterparties.name,
      tin: counterparties.tin,
      brigade: counterparties.brigadeCode,
      driver: drivers.fullName,
      plate: vehicles.plate,
      model: vehicles.model,
      transportOrg: vehicles.transportOrg,
      trailerPlate: vehicles.trailerPlate,
      garageNo: vehicles.garageNo,
      variety: varieties.code,
      batchNumber: batches.number,
      weigher: users.fullName,
    })
    .from(weighTickets)
    .innerJoin(counterparties, eq(counterparties.id, weighTickets.consignorId))
    .leftJoin(drivers, eq(drivers.id, weighTickets.driverId))
    .leftJoin(vehicles, eq(vehicles.id, weighTickets.vehicleId))
    .leftJoin(varieties, eq(varieties.id, weighTickets.varietyId))
    .leftJoin(batches, eq(batches.id, weighTickets.batchId))
    .leftJoin(users, eq(users.id, weighTickets.createdBy))
    .where(eq(weighTickets.id, id))
    .limit(1);

  if (!t) notFound();

  // How many times this Борхат has already been printed. Each print puts another stamped
  // driver's copy into the world, so the button says so and asks for a reason.
  // The moment each weighing was actually taken, off the append-only record — not the
  // moment the row happened to be written. The paper form carries a time too, and while
  // both systems are running in parallel this is what lets a printed ticket be matched
  // to a line in the handwritten book.
  const times = await db
    .select({
      kind: weighEvents.kind,
      capturedAt: weighEvents.capturedAt,
      id: weighEvents.id,
      supersedesId: weighEvents.supersedesId,
      recordedAt: weighEvents.recordedAt,
    })
    .from(weighEvents)
    .where(eq(weighEvents.ticketId, t.id))
    .orderBy(desc(weighEvents.recordedAt));

  const superseded = new Set(times.map((e) => e.supersedesId).filter(Boolean) as string[]);
  const liveAt = (kind: "GROSS" | "TARE") =>
    times.find((e) => e.kind === kind && !superseded.has(e.id))?.capturedAt ?? null;
  const grossAt = liveAt("GROSS");
  const tareAt = liveAt("TARE");
  const printedAt = new Date();

  const [printed] = await db
    .select({ n: raw<string>`COUNT(*)` })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, t.id), eq(auditLog.action, "ticket.print")));
  const printCount = Number(printed?.n ?? 0);

  const copies = [
    { key: "guard", label: tg.ticket.copyGuard, stamped: false },
    { key: "factory", label: tg.ticket.copyFactory, stamped: false },
    { key: "driver", label: tg.ticket.copyDriver, stamped: true },
  ] as const;

  return (
    <PrintPage>
      <div className="no-print mx-auto mb-4 flex max-w-[210mm] items-center gap-3 px-4">
        <a href="/tarozu" className="btn-secondary">{tg.common.back}</a>
        <span className="font-mono text-brand">{t.serial}</span>
        <span className="badge bg-white text-ink-soft">
          {tg.ticketStatus[t.status as keyof typeof tg.ticketStatus]}
        </span>
        {printCount > 0 && (
          <span className="badge bg-amber-100 text-warn">
            {tg.ticket.printedTimes}: {printCount}
          </span>
        )}
        <PrintButton ticketId={t.id} alreadyPrinted={printCount} />
      </div>

      {/* Browsers add their own page header and URL footer; only the operator can turn
          those off, in the print dialog. */}
      <p className="no-print mx-auto mb-3 max-w-[210mm] px-4 text-sm text-ink-soft">
        {tg.ticket.printHint}
      </p>

      <PrintSheet>
        {copies.map((copy, i) => (
          <TicketCopy
            key={copy.key}
            ticket={t}
            label={copy.label}
            stamped={copy.stamped}
            cutAbove={i > 0}
            grossAt={grossAt}
            tareAt={tareAt}
            printedAt={printedAt}
          />
        ))}
      </PrintSheet>
    </PrintPage>
  );
}

/** Exactly the columns the printed Борхат needs, in the order the paper form reads. */
interface Ticket {
  serial: string;
  serialNumber: number;
  season: number;
  status: string;
  createdAt: Date;
  weighedAt: Date | null;
  grossG: number | null;
  tareG: number | null;
  netG: number | null;
  grade: number | null;
  cottonClass: string | null;
  loadingPlace: string | null;
  unloadingPlace: string | null;
  routeNo: string | null;
  farm: string;
  tin: string | null;
  brigade: string | null;
  driver: string | null;
  plate: string | null;
  model: string | null;
  transportOrg: string | null;
  trailerPlate: string | null;
  garageNo: string | null;
  variety: string | null;
  batchNumber: number | null;
  weigher: string | null;
}

function TicketCopy({
  ticket: t, label, stamped, cutAbove, grossAt, tareAt, printedAt,
}: {
  ticket: Ticket; label: string; stamped: boolean; cutAbove: boolean;
  grossAt: Date | null; tareAt: Date | null; printedAt: Date;
}) {
  const date = (t.weighedAt ?? t.createdAt).toLocaleDateString("ru-RU", {
    day: "2-digit", month: "long", year: "numeric",
  });
  const hhmm = (d: Date | null) =>
    d ? d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "—";

  return (
    <PrintCopy
      formCode={tg.ticket.formCode}
      title={tg.ticket.title}
      serialLabel={tg.ticket.number}
      serialValue={t.serialNumber}
      copyLabel={label}
      cutAbove={cutAbove}
      right={
        <PrintIdentity season={t.season} batchNumber={t.batchNumber} serial={t.serial} />
      }
    >
      <PrintFields>
        <PrintField label={tg.ticket.date} value={date} />
        <PrintField label={tg.ticket.vehicle} value={[t.model, t.plate].filter(Boolean).join(" · ")} />
        <PrintField label={tg.ticket.transportOrg} value={t.transportOrg} />
        <PrintField label={tg.ticket.driver} value={t.driver} />
        <PrintField label={tg.ticket.consignor} value={t.farm} />
        <PrintField label={tg.ticket.tin} value={t.tin} />
        <PrintField label={tg.ticket.loadingPlace} value={t.loadingPlace} />
        <PrintField label={tg.ticket.brigade} value={t.brigade} />
        <PrintField label={tg.ticket.consignee} value={CONSIGNEE} />
        <PrintField label={tg.ticket.unloadingPlace} value={t.unloadingPlace} />
        <PrintField label={tg.ticket.route} value={t.routeNo} />
        <PrintField label={tg.ticket.garage} value={t.garageNo} />
      </PrintFields>

      <table className="mt-2 border-collapse text-center">
        <thead>
          <tr className="bg-paper text-[10px] text-ink-soft">
            <th className="border border-ink-faint px-2 py-0.5 font-medium">{tg.ticket.variety}</th>
            <th className="border border-ink-faint px-2 py-0.5 font-medium">{tg.ticket.grade}</th>
            <th className="border border-ink-faint px-2 py-0.5 font-medium">{tg.ticket.batch}</th>
            <th className="border border-ink-faint px-2 py-0.5 font-medium">{tg.ticket.cottonClass}</th>
            <th className="border border-ink-faint px-2 py-0.5 font-medium">{tg.ticket.gross}</th>
            <th className="border border-ink-faint px-2 py-0.5 font-medium">{tg.ticket.tare}</th>
            <th className="border-2 border-ink px-2 py-0.5 font-semibold text-ink">{tg.ticket.net}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="tabular">
            <td className="border border-ink-faint px-2 py-1">{t.variety ?? "—"}</td>
            <td className="border border-ink-faint px-2 py-1">{t.grade ?? "—"}</td>
            <td className="border border-ink-faint px-2 py-1">{t.batchNumber ?? "—"}</td>
            <td className="border border-ink-faint px-2 py-1">{t.cottonClass ?? "—"}</td>
            <td className="border border-ink-faint px-2 py-1">{kg(t.grossG)}</td>
            <td className="border border-ink-faint px-2 py-1">{kg(t.tareG)}</td>
            {/* Нетто is the number the whole document exists to record. */}
            <td className="print-net border-2 border-ink px-2 py-1 text-sm font-bold">
              {kg(t.netG)}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="flex justify-between text-[9px] text-ink-faint">
        <span>
          {tg.ticket.weighedAtLabel}: {tg.ticket.gross} {hhmm(grossAt)} · {tg.ticket.tare}{" "}
          {hhmm(tareAt)}
        </span>
        <span>{tg.ticket.weightSection}</span>
      </div>

      <PrintSignatures>
        <PrintSignature label={tg.ticket.merchandiser} name={t.weigher} />
        <PrintSignature label={tg.ticket.deliveredBy} name={t.driver} />
        <PrintSignature label={tg.ticket.receivedBy} />
      </PrintSignatures>

      {stamped && <PrintWarning>{tg.ticket.copyNotice}</PrintWarning>}

      {/* When this sheet came off the printer — distinct from when the truck was weighed,
          so a reprint is identifiable on the paper itself, not only in the audit log. */}
      <div className="text-end text-[8px] text-ink-faint">
        {tg.ticket.printedAtLabel}:{" "}
        {printedAt.toLocaleString("ru-RU", {
          day: "2-digit", month: "2-digit", year: "numeric",
          hour: "2-digit", minute: "2-digit",
        })}
      </div>
    </PrintCopy>
  );
}

function kg(grams: number | null): string {
  return grams === null ? "—" : gramsToKgString(grams, 1);
}
