import type { Metadata, Viewport } from "next";
import Link from "next/link";
import Nav from "./components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Гудини",
  description: "Сценарий, запись, монтаж и публикация коротких видео",
  // на iPhone «На экран Домой» открывает сайт без адресной строки, в тёмной теме
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Гудини" },
  // подтверждение владения доменом для Google Search Console (нужно, чтобы Google показывал
  // логотип и имя приложения на экране входа): токен из «HTML tag» кладётся в GOOGLE_SITE_VERIFICATION
  ...(process.env.GOOGLE_SITE_VERIFICATION ? { verification: { google: process.env.GOOGLE_SITE_VERIFICATION } } : {}),
};

// viewport-fit=cover: контент заходит под чёлку iPhone, отступы берутся из safe-area в CSS
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#101114",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <div className="container">
          <header className="topbar">
            <Link href="/" className="wordmark" aria-label="Гудини, на главную">
              Гудини
            </Link>
            <Nav />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
