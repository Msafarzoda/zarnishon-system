"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import type { Role } from "@/lib/auth/session";
import { tg } from "@/lib/i18n/tg";
import { Empty, Notice, Section, Stat } from "@/components/ui";
import {
  addUserAction,
  setActiveAction,
  setExtraRolesAction,
  setPasswordAction,
} from "./actions";

export interface UserRow {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  isSelf: boolean;
  /** Roles held on top of the primary one. docs/domain.md §6. */
  extraRoles: Role[];
  usesSeedPassword: boolean;
  openSessions: number;
  lastSeen: string | null;
  createdAt: string;
}

type State = { error?: string; ok?: string };

const ROLES: readonly Role[] = [
  "guard", "weigher", "lab", "merchandiser", "cashier", "accountant", "owner", "admin",
];

/**
 * What each role can actually reach, in the words of the job rather than of the code.
 * Whoever creates an account is deciding who may touch weight and money, so the
 * consequence of the choice is written next to it instead of left to be inferred.
 */
const ACCESS: Record<Role, string> = {
  guard: "Дарвоза — мошинҳои воридшаванда ва баромада",
  weigher: "Тарозу — борхат мекушояд, брутто ва тараро аз тарозу мегирад",
  lab: "Лаборатория — намӣ ва ифлосӣ, тасдиқи таҳлил",
  merchandiser: "Партияҳо ва хоҷагиҳо — маълумотнома, бе пул",
  cashier: "Хазина — пардохт ба хоҷагиҳо ва додани қарз",
  accountant: "Ҳама ҳисобот — танҳо барои дидан, амал намекунад",
  owner: "Ҳама чиз, аз ҷумла нарх — нархро танҳо ӯ мегузорад",
  admin: "Корбарон ва танзими система",
};

function when(iso: string | null): string {
  if (!iso) return tg.users.never;
  return new Date(iso).toLocaleDateString("ru-RU");
}

/**
 * Идора — the account list.
 *
 * Ordered so that the two things that need action come first: accounts still on the
 * seeded password, then disabled ones. Each row opens in place rather than on its own
 * screen, because the only two actions — change a password, switch an account off — are
 * both one field wide and are usually done with the person standing there.
 */
export function UsersClient({
  users, stationRoles,
}: {
  users: UserRow[];
  /** Passed in rather than imported: the auth module reaches for cookies and the database
   *  and cannot be pulled into a client bundle. One source of truth, still. */
  stationRoles: Role[];
}) {
  const needsStation = (r: Role) => stationRoles.includes(r);

  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const seedCount = users.filter((u) => u.usesSeedPassword && u.isActive).length;
  const activeCount = users.filter((u) => u.isActive).length;
  const signedIn = users.filter((u) => u.openSessions > 0).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? users.filter(
          (u) =>
            u.fullName.toLowerCase().includes(q) ||
            u.username.includes(q) ||
            tg.roles[u.role].toLowerCase().includes(q),
        )
      : users;
    return [...matched].sort((a, b) => {
      const weight = (u: UserRow) =>
        (!u.isActive ? 2 : 0) + (u.isActive && u.usesSeedPassword ? 3 : 0);
      return weight(b) - weight(a) || a.fullName.localeCompare(b.fullName);
    });
  }, [users, query]);

  return (
    <div className="space-y-5">
      {seedCount > 0 && <Notice tone="bad">{tg.users.seedWarning}</Notice>}
      {flash && <Notice tone="ok">{flash}</Notice>}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={tg.users.total} value={String(users.length)} />
        <Stat label={tg.users.activeCount} value={String(activeCount)} />
        <Stat label={tg.users.signedIn} value={String(signedIn)} />
        <Stat
          label={tg.users.seedCount}
          value={String(seedCount)}
          tone={seedCount > 0 ? "alarm" : undefined}
          accent={seedCount > 0}
        />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input min-w-56 flex-1"
          placeholder={tg.users.fullName}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="btn-primary"
          onClick={() => { setFlash(null); setAdding((v) => !v); }}
        >
          {adding ? tg.users.cancel : `+ ${tg.users.add}`}
        </button>
      </div>

      {adding && (
        <AddUserForm
          onDone={(message) => { setAdding(false); setFlash(message ?? null); }}
        />
      )}

      {filtered.length === 0 ? (
        <Empty title={users.length === 0 ? tg.users.noUsers : tg.common.noResults} />
      ) : (
        <ul className="space-y-2">
          {filtered.map((u) => (
            <li key={u.id}>
              <div
                className={`card px-4 py-3 ${
                  !u.isActive
                    ? "opacity-60"
                    : u.usesSeedPassword
                      ? "border-alarm/50"
                      : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => setOpenRow(openRow === u.id ? null : u.id)}
                  className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 text-start"
                >
                  <div className="min-w-48 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-semibold">{u.fullName}</span>
                      {u.isSelf && (
                        <span className="badge bg-paper text-ink-soft">{tg.users.you}</span>
                      )}
                      {!u.isActive && (
                        <span className="badge bg-red-50 text-alarm">{tg.users.disabled}</span>
                      )}
                      {u.isActive && u.usesSeedPassword && (
                        <span className="badge bg-red-50 text-alarm">
                          {tg.users.seedPassword}
                        </span>
                      )}
                      {/* Somebody doing more than one job — worth seeing without opening
                          the row, because it is what §5's separation of duties costs. */}
                      {u.extraRoles.length > 0 && (
                        <span className="badge bg-amber-100 text-warn">
                          +{u.extraRoles.map((r) => tg.roles[r]).join(", ")}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-faint">
                      <span className="tabular">{u.username}</span>
                      {needsStation(u.role) && <span>{tg.users.stationHint}</span>}
                    </div>
                  </div>

                  <Figure label={tg.users.role} value={tg.roles[u.role]} />
                  <Figure
                    label={tg.users.openSessions}
                    value={u.openSessions > 0 ? String(u.openSessions) : "—"}
                    tone={u.openSessions > 0 ? "brand" : undefined}
                  />
                  <Figure label={tg.users.lastSeen} value={when(u.lastSeen)} />

                  <span className="text-sm text-brand">{openRow === u.id ? "−" : "+"}</span>
                </button>

                {openRow === u.id && (
                  <div className="mt-4 space-y-4 border-t border-paper-line pt-4">
                    <p className="text-xs text-ink-faint">
                      <span className="font-medium text-ink-soft">{tg.users.roleAccess}:</span>{" "}
                      {ACCESS[u.role]}
                    </p>
                    <RolesForm user={u} />
                    <div className="grid gap-4 lg:grid-cols-2">
                      <PasswordForm user={u} />
                      <ActiveForm user={u} />
                    </div>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* The role table itself, so the choice in the add form can be made from the page. */}
      <Section title={tg.users.access} subtitle={tg.users.subtitle}>
        <ul className="divide-y divide-paper-line text-sm">
          {ROLES.map((r) => (
            <li key={r} className="flex flex-wrap items-baseline gap-x-3 py-2">
              <span className="min-w-36 font-medium">{tg.roles[r]}</span>
              <span className="flex-1 text-ink-soft">{ACCESS[r]}</span>
              {needsStation(r) && (
                <span className="badge bg-paper text-ink-faint">{tg.users.stationNeeded}</span>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Figure({
  label, value, tone,
}: { label: string; value: string; tone?: "brand" }) {
  return (
    <div className="min-w-24">
      <div className="text-xs text-ink-faint">{label}</div>
      <div className={`tabular ${tone === "brand" ? "text-brand font-semibold" : ""}`}>
        {value}
      </div>
    </div>
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

/**
 * Closes itself once the user is created. React clears a form after a successful action
 * but leaves component state alone, which left the role select showing one job while the
 * line under it described another — so the panel goes away instead of lingering in a
 * half-reset state, and the parent reports what happened.
 */
function AddUserForm({ onDone }: { onDone: (message?: string) => void }) {
  const [state, action, pending] = useActionState(addUserAction, {} as State);
  const [role, setRole] = useState<Role>("weigher");

  useEffect(() => {
    if (state.ok) onDone(state.ok);
  }, [state.ok, onDone]);

  return (
    <form action={action} className="card space-y-4 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="fullName">{tg.users.fullName}</label>
          <input id="fullName" name="fullName" required className="input"
                 placeholder="Ном Насаб" />
        </div>
        <div>
          <label className="label" htmlFor="username">{tg.users.username}</label>
          <input id="username" name="username" required autoComplete="off"
                 className="input tabular" placeholder="salimov" />
          <p className="mt-1 text-xs text-ink-faint">{tg.users.addHint}</p>
        </div>
        <div>
          <label className="label" htmlFor="role">{tg.users.role}</label>
          <select
            id="role" name="role" className="input" value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>{tg.roles[r]}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-faint">{ACCESS[role]}</p>
        </div>
        <div>
          <label className="label" htmlFor="password">{tg.users.password}</label>
          <input id="password" name="password" type="password" required minLength={6}
                 autoComplete="new-password" className="input" />
        </div>
      </div>
      <Feedback state={state} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="btn-primary">
          {pending ? tg.common.loading : tg.common.save}
        </button>
        <button type="button" className="btn-secondary" onClick={() => onDone()}>
          {tg.users.cancel}
        </button>
      </div>
    </form>
  );
}

/**
 * Granting one person more than one job.
 *
 * The primary role is shown but not offered: it is held already. The warning is not
 * decoration — with the scale, the lab and the cash desk in one pair of hands the system
 * can no longer stop that person inventing a load and paying themselves for it, and the
 * only control left is the paper running alongside. docs/domain.md §6.
 */
function RolesForm({ user }: { user: UserRow }) {
  const [state, action, pending] = useActionState(setExtraRolesAction, {} as State);
  const [chosen, setChosen] = useState<Role[]>(user.extraRoles);

  const toggle = (r: Role) =>
    setChosen((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  // Holding the scale and the cash desk at once is the combination that matters.
  const holdsMoneyAndWeight =
    [user.role, ...chosen].includes("cashier") &&
    [user.role, ...chosen].some((r) => r === "weigher" || r === "lab");

  return (
    <form action={action} className="space-y-3 rounded-lg border border-paper-line p-4">
      <input type="hidden" name="userId" value={user.id} />

      <div>
        <span className="label mb-0">{tg.users.extraRoles}</span>
        <p className="text-xs text-ink-faint">{tg.users.extraRolesHint}</p>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {ROLES.filter((r) => r !== user.role).map((r) => (
          <label key={r} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="extraRole"
              value={r}
              checked={chosen.includes(r)}
              onChange={() => toggle(r)}
            />
            {tg.roles[r]}
          </label>
        ))}
      </div>

      <p className="text-xs text-ink-faint">
        {tg.users.primaryRole}: <span className="font-medium">{tg.roles[user.role]}</span>
      </p>

      {holdsMoneyAndWeight && (
        <p className="rounded-lg border border-warn bg-amber-50 px-3 py-2 text-xs text-warn">
          {tg.users.separationWarning}
        </p>
      )}

      <Feedback state={state} />
      <button type="submit" disabled={pending} className="btn-secondary">
        {pending ? tg.common.loading : tg.users.saveRoles}
      </button>
    </form>
  );
}

function PasswordForm({ user }: { user: UserRow }) {
  const [state, action, pending] = useActionState(setPasswordAction, {} as State);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="userId" value={user.id} />
      <label className="label" htmlFor={`pw-${user.id}`}>{tg.users.newPassword}</label>
      <input
        id={`pw-${user.id}`} name="password" type="password" required minLength={6}
        autoComplete="new-password" className="input"
      />
      <Feedback state={state} />
      <button type="submit" disabled={pending} className="btn-secondary">
        {pending ? tg.common.loading : tg.users.changePassword}
      </button>
    </form>
  );
}

/**
 * Switching an account off is confirmed in the page, not in a browser dialog: the native
 * one cannot be written in Tajik, and a dialog the browser dismisses on its own would
 * silently swallow the click.
 *
 * The confirm button appears *below* the one that arms it rather than replacing it, and
 * the arm button goes disabled — so a click that lands twice hits a dead control instead
 * of arming and firing in one gesture. Turning an account back on is not guarded: it
 * takes nothing away.
 */
function ActiveForm({ user }: { user: UserRow }) {
  const [state, action, pending] = useActionState(setActiveAction, {} as State);
  const [armed, setArmed] = useState(false);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="userId" value={user.id} />
      <input type="hidden" name="active" value={user.isActive ? "false" : "true"} />
      <span className="label">{tg.users.access}</span>
      <p className="text-sm text-ink-soft">
        {user.isActive ? tg.users.active : tg.users.disabled}
        {user.openSessions > 0 && ` · ${tg.users.openSessions} ${user.openSessions}`}
      </p>
      <Feedback state={state} />

      {!user.isActive ? (
        <button type="submit" disabled={pending} className="btn-secondary">
          {pending ? tg.common.loading : tg.users.enable}
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={user.isSelf || armed}
            className="btn-danger"
            onClick={() => setArmed(true)}
          >
            {tg.users.disable}
          </button>

          {armed && (
            <div className="space-y-2 rounded border border-alarm bg-red-50 p-3">
              <p className="text-sm text-alarm">{tg.users.confirmDisable}</p>
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={pending || user.isSelf} className="btn-danger">
                  {pending ? tg.common.loading : tg.common.confirm}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setArmed(false)}
                >
                  {tg.common.cancel}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {user.isActive && user.isSelf && (
        <p className="text-xs text-ink-faint">{tg.users.cannotDisableSelf}</p>
      )}
    </form>
  );
}
