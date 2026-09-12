"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Проекты", match: (p: string) => p === "/" || p.startsWith("/project/") },
  { href: "/carousel", label: "Карусели", match: (p: string) => p.startsWith("/carousel") },
  { href: "/balances", label: "Расходы", match: (p: string) => p.startsWith("/balances") },
  { href: "/settings", label: "Настройки", match: (p: string) => p.startsWith("/settings") },
];

export default function Nav() {
  const pathname = usePathname() ?? "/";
  const ref = useRef<HTMLElement>(null);
  // на телефоне навигация прокручивается — текущий раздел должен быть виден
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  return (
    <nav className="topnav" aria-label="Разделы" ref={ref}>
      {LINKS.map((l) => {
        const active = l.match(pathname);
        return (
          <Link key={l.href} href={l.href} className={`nav-link${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
      {/* отдельное приложение (контейнер clipy), поэтому обычная ссылка, а не Link */}
      <a href="/clipy" className="nav-link">
        Clipy
      </a>
    </nav>
  );
}
