"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DomainError, gramsToKgString, kgStringToGrams } from "@/domain/units";
import { netWeight } from "@/domain/weight";
import { submit, drain } from "@/lib/offline/station-client";
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
  season: number;
  awaitingTare: AwaitingTare[];
  recentlyWeighed: {
    id: string; serial: string; netG: number | null; status: string;
    farm: string; plate: string | null;
  }[];
  farms: { id: string; name: string; tin: string | null; place: string | null }[];
  drivers: { id: string; fullName: string }[];
  vehicles: { id: string; plate: string; model: string | null }[];
  batches: { id: string; number: number; grade: number | null }[];
  varieties: { id: string; code: string }[];
}

type Notice = { tone: "ok" | "warn" | "bad"; text: string } | null;

export function ScaleClient(props: Props) {
  const router = useRouter();
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

      <div className="flex gap-2">
        <button
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
          onClick={() => setTab("arrive")}
          className={tab === "arrive" ? "btn-primary btn-lg" : "btn-secondary btn-lg"}
        >
          {tg.scale.captureGross}
        </button>
      </div>

      {tab === "arrive" ? (
        <ArrivalForm {...props} onNotice={setNotice} onDone={() => { setTab("depart"); router.refresh(); }} />
      ) : (
        <TareList
          tickets={props.awaitingTare}
          onNotice={setNotice}
          onDone={() => router.refresh()}
        />
      )}

      {props.recentlyWeighed.length > 0 && (
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink-soft">
            {tg.ticket.title} — {tg.dashboard.cottonReceived}
          </h2>
          <ul className="divide-y divide-paper-line text-sm">
            {props.recentlyWeighed.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2">
                <a href={`/borkhat/${t.id}`} className="font-mono text-brand hover:underline">
                  {t.serial}
                </a>
                <span className="text-ink-soft">{t.farm}</span>
                {t.plate && <span className="text-ink-faint">{t.plate}</span>}
                <span className="ms-auto tabular font-semibold">
                  {t.netG !== null ? `${gramsToKgString(t.netG, 1)} ${tg.common.kg}` : "—"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- arrival

function ArrivalForm({
  season, farms, drivers, vehicles, batches, varieties, onNotice, onDone,
}: Props & { onNotice: (n: Notice) => void; onDone: () => void }) {
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
  const [grossKg, setGrossKg] = useState("");
  const [busy, setBusy] = useState(false);

  const farm = farmList.find((f) => f.id === consignorId);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    onNotice(null);

    let weightG: number;
    try {
      weightG = kgStringToGrams(grossKg);
    } catch {
      onNotice({ tone: "bad", text: `${tg.scale.enterWeight} — ${tg.common.error}` });
      return;
    }
    if (weightG <= 0) {
      onNotice({ tone: "bad", text: tg.scale.enterWeight });
      return;
    }

    setBusy(true);
    try {
      // Open the ticket, then record the loaded weighing against it. Both carry their own
      // idempotency key, so a connection that dies between them cannot lose or duplicate one.
      const created = await submit<{ ticketId: string; serial: string }>("/api/tickets", {
        season,
        consignorId,
        driverId: driverId || undefined,
        vehicleId: vehicleId || undefined,
        batchId: batchId || undefined,
        varietyId: varietyId || undefined,
        loadingPlace: farm?.place ?? undefined,
      });

      if (created.kind === "rejected") {
        onNotice({ tone: "bad", text: created.message });
        return;
      }
      if (created.kind === "queued") {
        onNotice({
          tone: "warn",
          text: `${tg.app.offline}. ${tg.scale.captureGross}: ${grossKg} ${tg.common.kg}`,
        });
        return;
      }

      const weighed = await submit("/api/weighings", {
        ticketId: created.result.ticketId,
        kind: "GROSS",
        weightG,
        capturedAt: new Date().toISOString(),
        source: "manual",
      });

      if (weighed.kind === "rejected") {
        onNotice({ tone: "bad", text: weighed.message });
        return;
      }

      onNotice({
        tone: "ok",
        text: `${created.result.serial} — ${tg.ticket.gross} ${grossKg} ${tg.common.kg}`,
      });
      setGrossKg("");
      setDriverId("");
      setVehicleId("");
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
              { name: "name", label: tg.ticket.consignor, placeholder: "х-д Билол-Б", required: true },
              { name: "tin", label: `${tg.ticket.tin} (${tg.scale.tinHint})`, placeholder: "5830076707", inputMode: "numeric" },
              { name: "place", label: tg.ticket.loadingPlace, placeholder: "ч.Бустон" },
            ]}
            onCreate={async (values) => {
              const id = crypto.randomUUID();
              const res = await submit<{ id: string; name: string; tin: string | null }>(
                "/api/counterparties",
                { id, kind: "farm", name: values.name, tin: values.tin || undefined,
                  defaultLocation: values.place || undefined },
              );
              if (res.kind === "rejected") return { error: res.message };
              // Queued offline: the id is ours, so the ticket can name it straight away.
              setFarmList((list) => [
                ...list,
                { id, name: values.name!, tin: values.tin || null, place: values.place || null },
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
            { name: "plate", label: tg.ticket.vehicleHint, placeholder: "22-60", required: true },
            { name: "model", label: tg.ticket.vehicle, placeholder: "Газел 22-60" },
            { name: "transportOrg", label: tg.ticket.transportOrg, placeholder: "Хусусӣ" },
          ]}
          onCreate={async (values) => {
            const id = crypto.randomUUID();
            const res = await submit<{ id: string; plate: string; model: string | null }>(
              "/api/vehicles",
              { id, plate: values.plate, model: values.model || undefined,
                transportOrg: values.transportOrg || undefined },
            );
            if (res.kind === "rejected") return { error: res.message };
            // The server returns the existing row when this plate is already known.
            const resolved = res.kind === "applied" ? res.result.id : id;
            setVehicleList((list) =>
              list.some((v) => v.id === resolved)
                ? list
                : [...list, { id: resolved, plate: values.plate!, model: values.model || null }],
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
            { name: "fullName", label: tg.ticket.driverHint, placeholder: "Восиев Баҳром", required: true },
            { name: "phone", label: tg.ticket.driver, placeholder: "" },
          ]}
          onCreate={async (values) => {
            const id = crypto.randomUUID();
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

      <div className="rounded-lg bg-brand-light p-4">
        <label className="label text-brand-dark" htmlFor="gross">
          {tg.ticket.gross} — {tg.scale.enterWeight}
        </label>
        <p className="-mt-1 mb-2 text-sm text-brand-dark/75">{tg.scale.grossHint}</p>
        <input
          id="gross" inputMode="decimal" required autoComplete="off"
          className="input-number" placeholder="3015"
          value={grossKg} onChange={(e) => setGrossKg(e.target.value)}
        />
      </div>

      <button type="submit" disabled={busy || !consignorId || !batchId || !grossKg}
              className="btn-primary btn-lg w-full">
        {busy ? tg.common.loading : tg.scale.captureGross}
      </button>
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

      <select id={id} required={required} className="input mt-1" value={value}
              onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      {adding && (
        <div className="mt-2 space-y-2 rounded-lg border border-brand/30 bg-brand-light/50 p-3">
          <p className="text-sm font-medium text-brand-dark">{addLabel}</p>
          {fields.map((f) => (
            <div key={f.name}>
              <label className="label text-xs" htmlFor={`${id}-${f.name}`}>
                {f.label}{f.required && " *"}
              </label>
              <input
                id={`${id}-${f.name}`}
                className="input"
                inputMode={f.inputMode}
                placeholder={f.placeholder}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              />
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
  tickets, onNotice, onDone,
}: { tickets: AwaitingTare[]; onNotice: (n: Notice) => void; onDone: () => void }) {
  const [selected, setSelected] = useState<string | null>(tickets[0]?.id ?? null);

  if (tickets.length === 0) {
    return (
      <div className="card p-8 text-center text-ink-faint">{tg.gate.awaitingTare}: 0</div>
    );
  }

  return (
    <div className="space-y-3">
      {tickets.map((t) => (
        <TareCard
          key={t.id}
          ticket={t}
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
  ticket, open, onOpen, onNotice, onDone,
}: {
  ticket: AwaitingTare; open: boolean; onOpen: () => void;
  onNotice: (n: Notice) => void; onDone: () => void;
}) {
  const [tareKg, setTareKg] = useState("");
  const [busy, setBusy] = useState(false);

  // Show the operator the нетто as he types, before he commits it.
  let preview: { netG: number } | { error: string } | null = null;
  if (tareKg.trim() && ticket.grossG !== null) {
    try {
      preview = { netG: netWeight(ticket.grossG, kgStringToGrams(tareKg)) };
    } catch (err) {
      preview = { error: err instanceof DomainError ? tg.scale.tareTooBig : tg.common.error };
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    onNotice(null);
    if (!preview || "error" in preview) return;

    setBusy(true);
    try {
      const res = await submit<{ netG: number | null }>("/api/weighings", {
        ticketId: ticket.id,
        kind: "TARE",
        weightG: kgStringToGrams(tareKg),
        capturedAt: new Date().toISOString(),
        source: "manual",
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
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      <button onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-paper">
        <span className="font-mono text-brand">{ticket.serial}</span>
        <span className="font-medium">{ticket.farm}</span>
        {ticket.plate && <span className="text-ink-faint text-sm">{ticket.plate}</span>}
        {ticket.batchNumber !== null && (
          <span className="badge bg-paper text-ink-soft">
            {tg.ticket.batch} {ticket.batchNumber}
          </span>
        )}
        <span className="ms-auto tabular text-ink-soft">
          {tg.ticket.gross} {ticket.grossG !== null ? gramsToKgString(ticket.grossG, 0) : "—"} {tg.common.kg}
        </span>
      </button>

      {open && (
        <form onSubmit={onSubmit} className="border-t border-paper-line p-4 space-y-4">
          <div>
            <label className="label" htmlFor={`tare-${ticket.id}`}>
              {tg.ticket.tare} — {tg.scale.enterWeight}
            </label>
            <p className="-mt-1 mb-2 text-sm text-ink-soft">{tg.scale.tareHint}</p>
            <input
              id={`tare-${ticket.id}`} inputMode="decimal" autoComplete="off" autoFocus
              className="input-number" placeholder="2380"
              value={tareKg} onChange={(e) => setTareKg(e.target.value)}
            />
          </div>

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

          <div className="flex gap-2">
            <button type="submit"
                    disabled={busy || !preview || "error" in preview}
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
