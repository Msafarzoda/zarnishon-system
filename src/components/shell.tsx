import Link from "next/link";
import { tg } from "@/lib/i18n/tg";
import type { CurrentUser, Role } from "@/lib/auth/session";
import { SignOutButton } from "./sign-out-button";
import { ConnectionBadge } from "./connection-badge";
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
  const nav = NAV[user.role] ?? [];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="no-print bg-brand text-white">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center gap-4 flex-wrap">
          <Link href="/" className="font-bold tracking-tight">
            {tg.app.name}
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded px-3 py-1.5 hover:bg-white/15"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ms-auto flex items-center gap-3 text-sm">
            <ActorTag userId={user.id} />
            <ConnectionBadge />
            <span className="text-white/85">
              {user.fullName}
              <span className="text-white/60"> · {tg.roles[user.role]}</span>
              {user.stationName && <span className="text-white/60"> · {user.stationName}</span>}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <div className="no-print mb-5 flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-xl font-semibold">{title}</h1>
          {actions}
        </div>
        {children}
      </main>
    </div>
  );
}
