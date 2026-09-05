import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Гудини — ИИ-студия коротких видео",
  description: "Сценарий → съёмка → автомонтаж → публикация в TikTok, Shorts и Reels",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <div className="container">
          <header className="topbar">
            <Link href="/">
              <div className="logo">ГУДИНИ 🎩</div>
              <div className="logo-sub">магия коротких видео: сценарий → монтаж → публикация</div>
            </Link>
            <nav className="row">
              <Link className="nav-link" href="/">
                Проекты
              </Link>
              <Link className="nav-link" href="/balances">
                💳 Балансы
              </Link>
              <Link className="nav-link" href="/settings">
                ⚙ Настройки
              </Link>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
