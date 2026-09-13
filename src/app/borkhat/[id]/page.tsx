import { notFound, redirect } from "next/navigation";
import { and, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  batches,
  counterparties,
  drivers,
  users,
  varieties,
  vehicles,
  weighTickets,
} from "@/db/schema/index";
import { currentUser } from "@/lib/auth/session";
import { gramsToKgString } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

const CONSIGNEE = 'ЧДММ "ЗАРНИШОН"';

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/vorud");

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
    <div className="min-h-screen bg-paper py-6">
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

      <div className="borkhat-sheet mx-auto max-w-[210mm] space-y-4 px-4">
        {copies.map((copy, i) => (
          <TicketCopy
            key={copy.key}
            ticket={t}
            label={copy.label}
            stamped={copy.stamped}
            cutAbove={i > 0}
          />
        ))}
      </div>
    </div>
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
  ticket: t, label, stamped, cutAbove,
}: { ticket: Ticket; label: string; stamped: boolean; cutAbove: boolean }) {
  const date = (t.weighedAt ?? t.createdAt).toLocaleDateString("ru-RU", {
    day: "2-digit", month: "long", year: "numeric",
  });

  return (
    <article className="print-copy card relative bg-white p-4 text-[12px] leading-snug">
      {/* Where to cut the sheet into its three copies. */}
      {cutAbove && (
        <span className="absolute -top-2 left-3 bg-paper px-1 text-[10px] text-ink-faint print:bg-white">
          ✂ {tg.ticket.cutHere}
        </span>
      )}

      <header className="mb-2 flex items-start justify-between gap-3 border-b border-paper-line pb-1.5">
        <div>
          <div className="text-ink-faint">{tg.ticket.formCode}</div>
          <h2 className="font-bold uppercase tracking-wide">
            {tg.ticket.title} {tg.ticket.number}
            <span className="ms-2 font-mono text-base">{t.serialNumber}</span>
          </h2>
        </div>
        <div className="text-end">
          <div className="text-ink-faint">
            {tg.app.season}-{t.season} · {tg.ticket.batch}{" "}
            <strong className="text-ink">{t.batchNumber ?? "—"}</strong>
          </div>
          <div className="mt-0.5 font-semibold">{label}</div>
          {/* The system's own serial, so a printed ticket can be matched against the
              handwritten book while both are being kept in parallel. */}
          <div className="font-mono text-[9px] text-ink-faint">{t.serial}</div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-x-5">
        <Field label={tg.ticket.date} value={date} />
        <Field label={tg.ticket.vehicle} value={[t.model, t.plate].filter(Boolean).join(" · ")} />
        <Field label={tg.ticket.transportOrg} value={t.transportOrg} />
        <Field label={tg.ticket.driver} value={t.driver} />
        <Field label={tg.ticket.consignor} value={t.farm} />
        <Field label={tg.ticket.tin} value={t.tin} />
        <Field label={tg.ticket.loadingPlace} value={t.loadingPlace} />
        <Field label={tg.ticket.brigade} value={t.brigade} />
        <Field label={tg.ticket.consignee} value={CONSIGNEE} />
        <Field label={tg.ticket.unloadingPlace} value={t.unloadingPlace} />
        <Field label={tg.ticket.route} value={t.routeNo} />
        <Field label={tg.ticket.garage} value={t.garageNo} />
      </div>

      <table className="mt-2 w-full border-collapse text-center">
        <thead>
          <tr className="bg-paper text-[10px] text-ink-soft">
            <th className="border border-paper-line px-2 py-0.5 font-medium">{tg.ticket.variety}</th>
            <th className="border border-paper-line px-2 py-0.5 font-medium">{tg.ticket.grade}</th>
            <th className="border border-paper-line px-2 py-0.5 font-medium">{tg.ticket.batch}</th>
            <th className="border border-paper-line px-2 py-0.5 font-medium">{tg.ticket.cottonClass}</th>
            <th className="border border-paper-line px-2 py-0.5 font-medium">{tg.ticket.gross}</th>
            <th className="border border-paper-line px-2 py-0.5 font-medium">{tg.ticket.tare}</th>
            <th className="border border-paper-line px-2 py-0.5 font-medium">{tg.ticket.net}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="tabular">
            <td className="border border-paper-line px-2 py-1">{t.variety ?? "—"}</td>
            <td className="border border-paper-line px-2 py-1">{t.grade ?? "—"}</td>
            <td className="border border-paper-line px-2 py-1">{t.batchNumber ?? "—"}</td>
            <td className="border border-paper-line px-2 py-1">{t.cottonClass ?? "—"}</td>
            <td className="border border-paper-line px-2 py-1">{kg(t.grossG)}</td>
            <td className="border border-paper-line px-2 py-1">{kg(t.tareG)}</td>
            <td className="print-net border border-paper-line px-2 py-1 text-sm font-bold">
              {kg(t.netG)}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="text-end text-[9px] text-ink-faint">{tg.ticket.weightSection}</div>

      <div className="mt-3 grid grid-cols-3 gap-4 text-[9px]">
        <Signature label={tg.ticket.merchandiser} name={t.weigher} />
        <Signature label={tg.ticket.deliveredBy} name={t.driver} />
        <Signature label={tg.ticket.receivedBy} name={null} />
      </div>

      {stamped && (
        <p className="mt-1.5 border border-alarm/40 bg-red-50 px-2 py-1 text-[10px] font-medium text-alarm">
          {tg.ticket.copyNotice}
        </p>
      )}
    </article>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2 border-b border-dotted border-paper-line py-px">
      <span className="shrink-0 text-ink-faint">{label}</span>
      <span className="ms-auto text-end font-medium">{value || "—"}</span>
    </div>
  );
}

function Signature({ label, name }: { label: string; name: string | null }) {
  return (
    <div>
      <div className="h-5 border-b border-ink-faint" />
      <div className="mt-0.5 text-ink-faint">{label}</div>
      <div className="font-medium">{name ?? " "}</div>
    </div>
  );
}

function kg(grams: number | null): string {
  return grams === null ? "—" : gramsToKgString(grams, 1);
}
