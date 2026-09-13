"use client";

import { useActionState } from "react";
import { tg } from "@/lib/i18n/tg";
import { signInAction } from "./actions";

interface Station {
  id: string;
  code: string;
  nameTg: string;
}

export function SignInForm({ stations }: { stations: Station[] }) {
  const [state, action, pending] = useActionState(signInAction, {} as { error?: string });

  return (
    <form action={action} className="card p-6 space-y-4">
      <div>
        <label className="label" htmlFor="username">
          {tg.auth.username}
        </label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoFocus
          required
          className="input"
        />
      </div>

      <div>
        <label className="label" htmlFor="password">
          {tg.auth.password}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="input"
        />
      </div>

      {stations.length > 0 && (
        <div>
          <label className="label" htmlFor="stationId">
            {tg.auth.station}
          </label>
          {/* Recorded on everything this shift writes, so an entry can be traced to a desk. */}
          <select id="stationId" name="stationId" className="input" defaultValue="">
            <option value="">—</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nameTg}
              </option>
            ))}
          </select>
        </div>
      )}

      {state?.error && (
        <p role="alert" className="text-sm text-alarm">
          {state.error}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary btn-lg w-full">
        {pending ? tg.common.loading : tg.auth.signIn}
      </button>
    </form>
  );
}
