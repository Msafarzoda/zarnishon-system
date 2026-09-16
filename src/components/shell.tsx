import Link from "next/link";
import { tg } from "@/lib/i18n/tg";
import { needsStation, type CurrentUser, type Role } from "@/lib/auth/session";
import { SignOutButton } from "./sign-out-button";
import { ConnectionBadge } from "./connection-badge";
import { NavLink } from "./nav-link";
import { ActorTag } from "./actor-tag";

/** Which sections each role may open. Mirrors docs/domain.md §6. */
const NAV: Record<Role, { href: string; label: string }[]> = {
  guard: [{ href: "/darvoza", label: tg.nav.gate }],
  weigher: [
    { href: "/tarozu", label: tg.nav.scale },
    { href: "/darvoza", label: tg.nav.gate },
  ],
  lab: [{ href: "/laboratoriya", label: tg.nav.lab }],
  merchandiser: [
    { href: "/partiyaho", label: tg.nav.batches },
    { href: "/khojagiho", label: tg.nav.farms },
  ],
  cashier: [
    { href: "/hazina", label: tg.nav.cashdesk },
    { href: "/khojagiho", label: tg.nav.farms },
  ],
  accountant: [
    { href: "/hisobot", label: tg.nav.dashboard },
    { href: "/khojagiho", label: tg.nav.farms },
    { href: "/partiyaho", label: tg.nav.batches },
  ],
  owner: [
    { href: "/hisobot", label: tg.nav.dashboard },
    { href: "/narkhho", label: tg.nav.prices },
    { href: "/khojagiho", label: tg.nav.farms },
    { href: "/partiyaho", label: tg.nav.batches },
    { href: "/idora", label: tg.nav.users },
  ],
  admin: [
    { href: "/idora", label: tg.nav.users },
    { href: "/hisobot", label: tg.nav.dashboard },
  ],
};

export function Shell({
  user,
  title,
  actions,
  children,
}: {
  user: CurrentUser;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  /**
   * The union of every role this person holds, in the order the roles were granted, with
   * each screen listed once. An operator running the scale, the lab and the cash desk
   * needs all three in the bar — and needs them in a stable order, not shuffled by
   * whichever role happened to be primary.
   */
  /**
   * Somebody holding more than one operational job gets the work board first: it is the
   * screen that says what is left to do across all of them, and it is where signing in
   * already lands them.
   */
  const operational = user.roles.filter((r) =>
    (["weigher", "lab", "cashier", "merchandiser"] as Role[]).includes(r),
  );
  const board: { href: string; label: string }[] =
    operational.length > 1 ? [{ href: "/kor", label: tg.work.title }] : [];

  const nav = board.concat(user.roles
    .flatMap((r) => NAV[r] ?? []))
    .filter((item, i, all) => all.findIndex((x) => x.href === item.href) === i);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="no-print sticky top-0 z-10 bg-brand text-white shadow-sm">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-2.5">
          <Link href="/" className="font-bold tracking-tight">
            {tg.app.name}
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            {nav.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
          </nav>

          <div className="ms-auto flex items-center gap-3 text-sm">
            <ActorTag userId={user.id} />
            <ConnectionBadge />
            <span className="text-white/85">
              {user.fullName}
              <span className="text-white/60">
                {" · "}
                {/* Every job this person is doing, not just the one they are called by. */}
                {user.roles.map((r) => tg.roles[r]).join(" · ")}
              </span>
              {user.stationName && <span className="text-white/60"> · {user.stationName}</span>}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <div className="no-print mb-5 flex flex-wrap items-center justify-between gap-3">
          <h1 className="page-title">{title}</h1>
          {actions}
        </div>

        {/* A session started before the station became compulsory, or by someone who
            skipped the field. Everything they do will be refused, so say so once, here,
            rather than as a failure on the first truck. */}
        {user.roles.some(needsStation) && !user.stationId && (
          <div className="no-print mb-5 card border-alarm bg-red-50 px-4 py-3">
            <p className="font-semibold text-alarm">{tg.auth.stationMissing}</p>
            <p className="mt-0.5 text-sm text-alarm/90">{tg.auth.stationMissingHint}</p>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
