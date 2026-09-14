"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Marks the section the operator is actually in — on a shared terminal that is not obvious. */
export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} className={`nav-link ${active ? "nav-link-active" : ""}`}>
      {label}
    </Link>
  );
}
