"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Проекты", match: (p: string) => p === "/" || p.startsWith("/project/") },
  { href: "/balances", label: "Расходы", match: (p: string) => p.startsWith("/balances") },
  { href: "/settings", label: "Настройки", match: (p: string) => p.startsWith("/settings") },
];

export default function Nav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="topnav" aria-label="Разделы">
      {LINKS.map((l) => {
        const active = l.match(pathname);
        return (
          <Link key={l.href} href={l.href} className={`nav-link${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
