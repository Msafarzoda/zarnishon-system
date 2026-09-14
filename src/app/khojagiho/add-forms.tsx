"use client";

import { useActionState, useState } from "react";
import { TRANSPORT_ORGS } from "@/domain/plate";
import { tg } from "@/lib/i18n/tg";
import { addDriverAction, addFarmAction, addVehicleAction } from "./actions";

type State = { error?: string; ok?: string };

export function AddForms() {
  const [open, setOpen] = useState<"farm" | "vehicle" | "driver" | null>(null);

  // Returns two flex children of the control row: the triggers, and — when one is open —
  // a full-width panel that `flex-wrap` drops onto its own line beneath them.
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary"
                onClick={() => setOpen(open === "farm" ? null : "farm")}>
          + {tg.ticket.consignor}
        </button>
        <button type="button" className="btn-secondary"
                onClick={() => setOpen(open === "vehicle" ? null : "vehicle")}>
          + {tg.ticket.vehicle}
        </button>
        <button type="button" className="btn-secondary"
                onClick={() => setOpen(open === "driver" ? null : "driver")}>
          + {tg.ticket.driver}
        </button>
      </div>

      {open && (
        <div className="w-full basis-full">
          {open === "farm" && <FarmForm />}
          {open === "vehicle" && <VehicleForm />}
          {open === "driver" && <DriverForm />}
        </div>
      )}
    </>
  );
}

function Feedback({ state }: { state: State }) {
  return (
    <>
      {state?.error && <p role="alert" className="text-sm text-alarm">{state.error}</p>}
      {state?.ok && <p role="status" className="text-sm text-brand">{state.ok}</p>}
    </>
  );
}

function FarmForm() {
  const [state, action, pending] = useActionState(addFarmAction, {} as State);
  return (
    <form action={action} className="card p-5 space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="name">{tg.ticket.consignor}</label>
          <input id="name" name="name" required className="input" placeholder="х-д Билол-Б" />
        </div>
        <div>
          <label className="label" htmlFor="tin">{tg.ticket.tin}</label>
          <input id="tin" name="tin" className="input tabular" placeholder="5830076707" />
        </div>
        <div>
          <label className="label" htmlFor="place">{tg.ticket.loadingPlace}</label>
          <input id="place" name="place" className="input" placeholder="ч.Бустон" />
        </div>
        <div>
          <label className="label" htmlFor="brigade">{tg.ticket.brigade}</label>
          <input id="brigade" name="brigade" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="phone">{tg.common.phone}</label>
          <input id="phone" name="phone" type="tel" className="input"
                 placeholder="+992 __ ___ __ __" />
        </div>
      </div>
      <input type="hidden" name="kind" value="farm" />
      <Feedback state={state} />
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? tg.common.loading : tg.common.save}
      </button>
    </form>
  );
}

function VehicleForm() {
  const [state, action, pending] = useActionState(addVehicleAction, {} as State);
  return (
    <form action={action} className="card p-5 space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="plate">{tg.ticket.vehicleHint}</label>
          <input id="plate" name="plate" required className="input tabular"
                 placeholder="1234 AB 01" />
        </div>
        <div>
          <label className="label" htmlFor="model">{tg.ticket.vehicle}</label>
          <input id="model" name="model" className="input" placeholder="Газел" />
        </div>
        <div>
          <label className="label" htmlFor="transportOrg">{tg.ticket.transportOrg}</label>
          <select id="transportOrg" name="transportOrg" className="input" defaultValue="Хусусӣ">
            {TRANSPORT_ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      </div>
      <Feedback state={state} />
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? tg.common.loading : tg.common.save}
      </button>
    </form>
  );
}

function DriverForm() {
  const [state, action, pending] = useActionState(addDriverAction, {} as State);
  return (
    <form action={action} className="card p-5 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="fullName">{tg.ticket.driverHint}</label>
          <input id="fullName" name="fullName" required className="input"
                 placeholder="Восиев Баҳром" />
        </div>
        <div>
          <label className="label" htmlFor="dphone">{tg.common.phone}</label>
          <input id="dphone" name="phone" type="tel" className="input"
                 placeholder="+992 __ ___ __ __" />
        </div>
      </div>
      <Feedback state={state} />
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? tg.common.loading : tg.common.save}
      </button>
    </form>
  );
}
