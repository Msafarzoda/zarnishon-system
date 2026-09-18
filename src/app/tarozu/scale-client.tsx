"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DomainError, gramsToKgString, kgStringToGrams } from "@/domain/units";
import { netWeight } from "@/domain/weight";
import { TRANSPORT_ORGS, normalisePlate } from "@/domain/plate";
import { submit, drain } from "@/lib/offline/station-client";
import { TicketProgress, waitingFor } from "@/components/ticket-progress";
import { newClientUuid } from "@/lib/offline/outbox";
import { useWeighbridge } from "@/lib/scale/use-weighbridge";
import { ScalePanel } from "@/components/scale-panel";
import { ManualWeight } from "@/components/manual-weight";
import { SearchableSelect } from "@/components/searchable-select";
import { tg } from "@/lib/i18n/tg";

interface AwaitingTare {
  id: string;
  serial: string;
  grossG: number | null;
  createdAt: string;
  farm: string;
  plate: string | null;
  model: string | null;
  driver: string | null;
  batchNumber: number | null;
}

interface Props {
  /** A watcher — owner or accountant — sees the board but cannot weigh. */
  readOnly?: boolean;
  /** Simulation is for rehearsing without the indicator; the server turns it off in production. */
  allowSimulation: boolean;
  season: number;
  awaitingTare: AwaitingTare[];
  recentlyWeighed: {
    id: string; serial: string; grossG: number | null; tareG: number | null;
    netG: number | null; status: string; farm: string; plate: string | null;
  }[];
  farms: { id: string; name: string; tin: string | null; place: string | null; phone: string | null }[];
  drivers: { id: string; fullName: string }[];
  vehicles: { id: string; plate: string; model: string | null }[];
  batches: { id: string; number: number; grade: number | null }[];
  varieties: { id: string; code: string }[];
}

type Notice = { tone: "ok" | "warn" | "bad"; text: string } | null;

export function ScaleClient(props: Props) {
  const router = useRouter();
  // One connection to the indicator for the whole screen — брутто and тара read the same
  // port, and opening it twice would fail.
  const scale = useWeighbridge();
  const [tab, setTab] = useState<"arrive" | "depart">(
    props.awaitingTare.length > 0 ? "depart" : "arrive",
  );
  const [notice, setNotice] = useState<Notice>(null);

  // Drain anything queued while the station was offline, as soon as it is back.
  useEffect(() => {
    const onOnline = () => {
      void drain().then((r) => {
        if (r.applied > 0) router.refresh();
      });
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [router]);

  return (
    <div className="space-y-5">
      {notice && (
        <div
          role="status"
          className={`card px-4 py-3 ${
            notice.tone === "ok"
              ? "border-brand bg-brand-light text-brand-dark"
              : notice.tone === "warn"
                ? "border-warn bg-amber-50 text-warn"
                : "border-alarm bg-red-50 text-alarm"
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className={`flex gap-2 ${props.readOnly ? "hidden" : ""}`}>
        <button
          type="button"
          onClick={() => setTab("depart")}
          className={tab === "depart" ? "btn-primary btn-lg" : "btn-secondary btn-lg"}
        >
          {tg.scale.captureTare}
          {props.awaitingTare.length > 0 && (
            <span className="ms-2 rounded-full bg-white/25 px-2 text-sm">
              {props.awaitingTare.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab("arrive")}
          className={tab === "arrive" ? "btn-primary btn-lg" : "btn-secondary btn-lg"}
        >
          {tg.scale.captureGross}
        </button>
      </div>

      {props.readOnly ? null : tab === "arrive" ? (
        <ArrivalForm
          {...props}
          scale={scale}
          onNotice={setNotice}
          onDone={() => { setTab("depart"); router.refresh(); }}
        />
      ) : (
        <TareList
          tickets={props.awaitingTare}
          scale={scale}
          allowSimulation={props.allowSimulation}
          onNotice={setNotice}
          onDone={() => router.refresh()}
        />
      )}

      {/* A watcher still needs to see what is on site, just not act on it. */}
      {props.readOnly && props.awaitingTare.length > 0 && (
        <ul className="space-y-2">
          {props.awaitingTare.map((t) => (
            <li key={t.id} className="card px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-lg font-semibold">{t.farm}</span>
                <span className="font-mono text-sm text-brand">{t.serial}</span>
                {t.plate && <span className="text-sm text-ink-soft">{t.plate}</span>}
                <span className="ms-auto text-sm text-ink-faint">
                  {tg.gate.onSiteSince} {waited(t.createdAt)}
                </span>
              </div>
              <div className="mt-2">
                <TicketProgress
                  ticket={{ grossG: t.grossG, tareG: null, netG: null, status: "OPEN" }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {props.recentlyWeighed.length > 0 && (
        <section className="card p-4 sm:p-5">
          <h2 className="mb-3 text-sm font-semibold text-ink-soft">
            {tg.ticket.title} — {tg.dashboard.cottonReceived}
          </h2>
          <ul className="divide-y divide-paper-line">
            {props.recentlyWeighed.map((t) => {
              const still = waitingFor(t);
              return (
                <li key={t.id} className="py-2.5">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{t.farm}</span>
                    <a href={`/borkhat/${t.id}`}
                       className="font-mono text-sm text-brand hover:underline">
                      {t.serial}
                    </a>
                    {t.plate && <span className="text-sm text-ink-faint">{t.plate}</span>}
                    <span className="ms-auto tabular text-lg font-bold">
                      {t.netG !== null ? gramsToKgString(t.netG, 1) : "—"}
                      <span className="ms-1 text-sm font-medium text-ink-soft">
                        {tg.common.kg}
                      </span>
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <TicketProgress ticket={t} size="sm" />
                    {/* A finished ticket says so; an unfinished one says what it needs. */}
                    {still && (
                      <span
                        className={`text-xs ${still.outstanding ? "text-warn" : "text-brand"}`}
                      >
                        {still.outstanding
                          ? `${tg.gate.waitingFor}: ${still.label}`
                          : `${still.label} — ${tg.cash.farmerChoosesWhen}`}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- arrival

function ArrivalForm({
  season, farms, drivers, vehicles, batches, varieties, scale, allowSimulation,
  onNotice, onDone,
}: Props & {
  scale: ReturnType<typeof useWeighbridge>;
  onNotice: (n: Notice) => void;
  onDone: () => void;
}) {
  // Local copies, because the weigher may add a farm, a truck or a driver right here
  // with the vehicle already on the scale. See src/server/services/registry.ts.
  const [farmList, setFarmList] = useState(farms);
  const [driverList, setDriverList] = useState(drivers);
  const [vehicleList, setVehicleList] = useState(vehicles);

  const [consignorId, setConsignorId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [varietyId, setVarietyId] = useState(varieties[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  // Set only when the indicator cannot be used and a supervisor overrides it by hand.
  const [manual, setManual] = useState<{ weightG: number; reason: string } | null>(null);

  // The latched reading, not the live one: a real indicator's stable flag flickers, and
  // reading it live meant the button could disable between the operator deciding and
  // pressing.
  const fromScale = scale.held;
  const weightG = manual?.weightG ?? fromScale?.weightG ?? null;

  const farm = farmList.find((f) => f.id === consignorId);

  // Everything still standing between the operator and a saved Борхат, named. The button
  // was simply disabled before, which looks identical to a screen that does not work.
  const missing: string[] = [];
  if (!consignorId) missing.push(tg.ticket.consignor);
  if (!batchId) missing.push(tg.ticket.batch);
  if (weightG === null || weightG <= 0) {
    missing.push(
      scale.status === "streaming" && !scale.settled ? tg.scale.unstable : tg.ticket.gross,
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    onNotice(null);
    if (weightG === null || weightG <= 0) return;

    setBusy(true);
    try {
      // Open the ticket, then record the loaded weighing against it. Both carry their own
      // idempotency key, so a connection that dies between them cannot lose or duplicate one.
      // Opening the Борхат and taking брутто are one action, sent as one call. As two,
      // a failure in between left a ticket with no weight, invisible in both tabs.
      // The raw indicator frame travels with it, so what the scale actually said is on
      // the record and not merely what the screen showed.
      const created = await submit<{ ticketId: string; serial: string }>("/api/tickets", {
        season,
        consignorId,
        driverId: driverId || undefined,
        vehicleId: vehicleId || undefined,
        batchId: batchId || undefined,
        varietyId: varietyId || undefined,
        loadingPlace: farm?.place ?? undefined,
        gross: {
          clientUuid: newClientUuid(),
          weightG,
          capturedAt: new Date().toISOString(),
          source: manual || scale.simulated ? "manual" : "indicator",
          indicatorRaw: manual || scale.simulated ? undefined : (fromScale?.raw ?? undefined),
          reason: manual?.reason ?? (scale.simulated ? tg.scale.simulationReason : undefined),
        },
      });

      if (created.kind === "rejected") {
        onNotice({ tone: "bad", text: created.message });
        return;
      }
      if (created.kind === "queued") {
        onNotice({
          tone: "warn",
          text: `${tg.app.offline}. ${tg.scale.captureGross}: ` +
            `${gramsToKgString(weightG, 1)} ${tg.common.kg}`,
        });
        return;
      }

      onNotice({
        tone: "ok",
        text: `${created.result.serial} — ${tg.ticket.gross} ` +
          `${gramsToKgString(weightG, 1)} ${tg.common.kg}`,
      });
      setManual(null);
      setDriverId("");
      setVehicleId("");
      scale.release();
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-5 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <SelectWithAdd
            id="consignor"
            label={tg.ticket.consignor}
            value={consignorId}
            onChange={setConsignorId}
            required
            options={farmList.map((f) => ({
              value: f.id,
              label: f.tin ? `${f.name} · ${f.tin}` : f.name,
            }))}
            addLabel={tg.scale.newFarm}
            fields={[
              { name: "name", label: tg.ticket.consignor, placeholder: "х-д Намуна", required: true },
              { name: "tin", label: `${tg.ticket.tin} (${tg.scale.tinHint})`, placeholder: "0000000000", inputMode: "numeric" },
              { name: "place", label: tg.ticket.loadingPlace, placeholder: "ч.Бустон" },
              { name: "phone", label: tg.common.phone, placeholder: "+992 __ ___ __ __" },
            ]}
            onCreate={async (values) => {
              const id = newClientUuid();
              const res = await submit<{ id: string; name: string; tin: string | null }>(
                "/api/counterparties",
                { id, kind: "farm", name: values.name, tin: values.tin || undefined,
                  defaultLocation: values.place || undefined,
                  phone: values.phone || undefined },
              );
              if (res.kind === "rejected") return { error: res.message };
              // Queued offline: the id is ours, so the ticket can name it straight away.
              setFarmList((list) => [
                ...list,
                {
                  id,
                  name: values.name!,
                  tin: values.tin || null,
                  place: values.place || null,
                  phone: values.phone || null,
                },
              ]);
              setConsignorId(id);
              return { ok: true };
            }}
          />
        </div>

        <SelectWithAdd
          id="vehicle"
          label={tg.ticket.vehicle}
          value={vehicleId}
          onChange={setVehicleId}
          options={vehicleList.map((v) => ({
            value: v.id,
            label: `${v.model ?? v.plate} · ${v.plate}`,
          }))}
          addLabel={tg.scale.newVehicle}
          fields={[
            { name: "plate", label: tg.ticket.vehicleHint, placeholder: "1234 AB 01", required: true },
            { name: "model", label: tg.ticket.vehicle, placeholder: "Газел" },
            { name: "transportOrg", label: tg.ticket.transportOrg, options: TRANSPORT_ORGS },
          ]}
          onCreate={async (values) => {
            const id = newClientUuid();
            const res = await submit<{ id: string; plate: string; model: string | null }>(
              "/api/vehicles",
              { id, plate: values.plate, model: values.model || undefined,
                transportOrg: values.transportOrg || undefined },
            );
            if (res.kind === "rejected") return { error: res.message };
            // The server returns the existing row when this plate is already known.
            const resolved = res.kind === "applied" ? res.result.id : id;
            const storedPlate =
              res.kind === "applied" ? res.result.plate : normalisePlate(values.plate!).plate;
            setVehicleList((list) =>
              list.some((v) => v.id === resolved)
                ? list
                : [...list, { id: resolved, plate: storedPlate, model: values.model || null }],
            );
            setVehicleId(resolved);
            return { ok: true };
          }}
        />

        <SelectWithAdd
          id="driver"
          label={tg.ticket.driver}
          value={driverId}
          onChange={setDriverId}
          options={driverList.map((d) => ({ value: d.id, label: d.fullName }))}
          addLabel={tg.scale.newDriver}
          fields={[
            { name: "fullName", label: tg.ticket.driverHint, placeholder: "Ном Насаб", required: true },
            { name: "phone", label: tg.ticket.driver, placeholder: "" },
          ]}
          onCreate={async (values) => {
            const id = newClientUuid();
            const res = await submit<{ id: string }>("/api/drivers", {
              id, fullName: values.fullName, phone: values.phone || undefined,
            });
            if (res.kind === "rejected") return { error: res.message };
            setDriverList((list) => [...list, { id, fullName: values.fullName! }]);
            setDriverId(id);
            return { ok: true };
          }}
        />

        <div>
          <label className="label" htmlFor="batch">{tg.scale.assignBatch}</label>
          <select id="batch" required className="input" value={batchId}
                  onChange={(e) => setBatchId(e.target.value)}>
            <option value="">—</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {tg.ticket.batch} {b.number}{b.grade ? ` · ${tg.ticket.grade} ${b.grade}` : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="variety">{tg.ticket.variety}</label>
          <select id="variety" className="input" value={varietyId}
                  onChange={(e) => setVarietyId(e.target.value)}>
            {varieties.map((v) => <option key={v.id} value={v.id}>{v.code}</option>)}
          </select>
        </div>
      </div>

      <ScalePanel scale={scale} label={tg.ticket.gross} hint={tg.scale.grossHint}
                  allowSimulation={allowSimulation} />

      <ManualWeight
        value={manual}
        onChange={setManual}
        scaleAvailable={scale.status === "streaming"}
      />

      <button type="submit"
              disabled={busy || missing.length > 0}
              className="btn-primary btn-lg w-full">
        {busy ? tg.common.loading : tg.scale.captureGross}
      </button>
      {missing.length > 0 && (
        <p className="text-center text-sm text-warn">
          {tg.scale.cannotSaveYet}: {missing.join(" · ")}
        </p>
      )}
    </form>
  );
}

// -------------------------------------------------------------- select + add

interface QuickField {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  inputMode?: "text" | "numeric" | "decimal";
  /** When present the field is a dropdown — a fixed vocabulary, not free text. */
  options?: readonly string[];
}

/**
 * A dropdown with a "нав" button that adds a record without leaving the weighbridge.
 *
 * A truck with an unknown plate, or a farm delivering for the first time, must not stop
 * the scale — otherwise the load goes on paper and is "entered later", which is the hole
 * this system exists to close.
 */
function SelectWithAdd({
  id, label, value, onChange, options, addLabel, fields, onCreate, required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  addLabel: string;
  fields: QuickField[];
  onCreate: (values: Record<string, string>) => Promise<{ ok?: true; error?: string }>;
  required?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setError(null);
    for (const f of fields) {
      if (f.required && !values[f.name]?.trim()) {
        setError(tg.common.required);
        return;
      }
    }
    setBusy(true);
    try {
      const result = await onCreate(values);
      if (result.error) {
        setError(result.error);
        return;
      }
      setValues({});
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between gap-2">
        <label className="label mb-0" htmlFor={id}>{label}</label>
        <button
          type="button"
          onClick={() => { setAdding((v) => !v); setError(null); }}
          className="mb-1 rounded px-2 py-0.5 text-sm font-medium text-brand hover:bg-brand-light"
        >
          {adding ? tg.common.cancel : `+ ${tg.scale.addNew}`}
        </button>
      </div>

      <SearchableSelect id={id} value={value} onChange={onChange} options={options} />

      {adding && (
        <div className="mt-2 space-y-2 rounded-lg border border-brand/30 bg-brand-light/50 p-3">
          <p className="text-sm font-medium text-brand-dark">{addLabel}</p>
          {fields.map((f) => (
            <div key={f.name}>
              <label className="label text-xs" htmlFor={`${id}-${f.name}`}>
                {f.label}{f.required && " *"}
              </label>
              {f.options ? (
                <select
                  id={`${id}-${f.name}`}
                  className="input"
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                >
                  <option value="">—</option>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  id={`${id}-${f.name}`}
                  className="input"
                  inputMode={f.inputMode}
                  placeholder={f.placeholder}
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                />
              )}
            </div>
          ))}
          {error && <p role="alert" className="text-sm text-alarm">{error}</p>}
          {/* Not a submit button: it must not submit the Борхат form around it. */}
          <button type="button" onClick={save} disabled={busy} className="btn-primary w-full">
            {busy ? tg.common.loading : tg.common.save}
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------ tare

function TareList({
  tickets, scale, allowSimulation, onNotice, onDone,
}: {
  tickets: AwaitingTare[];
  scale: ReturnType<typeof useWeighbridge>;
  allowSimulation: boolean;
  onNotice: (n: Notice) => void;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(tickets[0]?.id ?? null);

  if (tickets.length === 0) {
    return (
      <div className="card p-10 text-center">
        <p className="text-ink-faint">{tg.gate.awaitingTare}: 0</p>
        <p className="mt-2 text-sm text-ink-soft">{tg.scale.noTrucksWaiting}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tickets.map((t) => (
        <TareCard
          key={t.id}
          ticket={t}
          scale={scale}
          allowSimulation={allowSimulation}
          open={selected === t.id}
          onOpen={() => setSelected(selected === t.id ? null : t.id)}
          onNotice={onNotice}
          onDone={onDone}
        />
      ))}
    </div>
  );
}

function TareCard({
  ticket, scale, allowSimulation, open, onOpen, onNotice, onDone,
}: {
  ticket: AwaitingTare;
  scale: ReturnType<typeof useWeighbridge>;
  allowSimulation: boolean;
  open: boolean; onOpen: () => void;
  onNotice: (n: Notice) => void; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<{ weightG: number; reason: string } | null>(null);

  const fromScale = scale.held;
  const tareG = manual?.weightG ?? fromScale?.weightG ?? null;

  // Show the нетто the moment the platform settles, before anything is committed.
  let preview: { netG: number } | { error: string } | null = null;
  if (tareG !== null && ticket.grossG !== null) {
    try {
      preview = { netG: netWeight(ticket.grossG, tareG) };
    } catch (err) {
      preview = { error: err instanceof DomainError ? tg.scale.tareTooBig : tg.common.error };
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    onNotice(null);
    if (!preview || "error" in preview || tareG === null) return;

    setBusy(true);
    try {
      const res = await submit<{ netG: number | null }>("/api/weighings", {
        ticketId: ticket.id,
        kind: "TARE",
        weightG: tareG,
        capturedAt: new Date().toISOString(),
        source: manual || scale.simulated ? "manual" : "indicator",
        indicatorRaw: manual || scale.simulated ? undefined : (fromScale?.raw ?? undefined),
        reason: manual?.reason ?? (scale.simulated ? tg.scale.simulationReason : undefined),
      });

      if (res.kind === "rejected") {
        onNotice({ tone: "bad", text: res.message });
        return;
      }
      if (res.kind === "queued") {
        onNotice({ tone: "warn", text: `${ticket.serial} — ${tg.app.offline}` });
        return;
      }

      onNotice({
        tone: "ok",
        text: `${ticket.serial} — ${tg.ticket.net} ${gramsToKgString(preview.netG, 1)} ${tg.common.kg}`,
      });
      scale.release();
      onDone();
    } finally {
      setBusy(false);
    }
  }

  const stage = {
    grossG: ticket.grossG,
    tareG: null,
    netG: null,
    status: "OPEN",
  };

  return (
    <div className={`card overflow-hidden ${open ? "ring-2 ring-brand/30" : ""}`}>
      <button
        type="button"
        onClick={onOpen}
        className="w-full px-4 py-3 text-start transition-colors hover:bg-paper"
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-lg font-semibold">{ticket.farm}</span>
          <span className="font-mono text-sm text-brand">{ticket.serial}</span>
          {ticket.plate && <span className="text-sm text-ink-soft">{ticket.plate}</span>}
          {ticket.driver && <span className="text-sm text-ink-faint">{ticket.driver}</span>}
          {ticket.batchNumber !== null && (
            <span className="badge bg-paper text-ink-soft">
              {tg.ticket.batch} {ticket.batchNumber}
            </span>
          )}
          {/* How long this truck has been on site. A load waiting hours is a problem
              somebody should be looking at. */}
          <span className="ms-auto text-sm text-ink-faint">
            {tg.gate.onSiteSince} {waited(ticket.createdAt)}
          </span>
        </div>

        <div className="mt-2">
          <TicketProgress ticket={stage} />
        </div>
      </button>

      {open && (
        <form onSubmit={onSubmit} className="border-t border-paper-line p-4 space-y-4">
          <ScalePanel scale={scale} label={tg.ticket.tare} hint={tg.scale.tareHint}
                      allowSimulation={allowSimulation} />

          <ManualWeight
            value={manual}
            onChange={setManual}
            scaleAvailable={scale.status === "streaming"}
          />

          {preview && (
            "error" in preview ? (
              <p className="text-alarm font-medium">{preview.error}</p>
            ) : (
              <div className="rounded-lg bg-brand-light px-4 py-3">
                <span className="text-sm text-brand-dark">
                  {tg.ticket.net} — {tg.scale.netHint}
                </span>
                <div className="tabular text-3xl font-bold text-brand-dark">
                  {gramsToKgString(preview.netG, 1)} {tg.common.kg}
                </div>
              </div>
            )
          )}

          {tareG === null && (
            <p className="text-sm text-warn">
              {tg.scale.cannotSaveYet}:{" "}
              {scale.status === "streaming" && !scale.settled
                ? tg.scale.unstable
                : tg.ticket.tare}
            </p>
          )}

          <div className="flex gap-2">
            <button type="submit"
                    disabled={busy || !preview || "error" in preview || tareG === null}
                    className="btn-primary btn-lg flex-1">
              {busy ? tg.common.loading : tg.scale.captureTare}
            </button>
            <a href={`/borkhat/${ticket.id}`} className="btn-secondary btn-lg">
              {tg.scale.printTicket}
            </a>
          </div>
        </form>
      )}
    </div>
  );
}


/** How long a truck has been on site, in the coarse terms an operator thinks in. */
function waited(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} ${tg.common.minutesShort}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${tg.common.hoursShort} ${minutes % 60} ${tg.common.minutesShort}`;
}
