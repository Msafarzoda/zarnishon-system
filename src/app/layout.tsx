import type { Metadata, Viewport } from "next";
import { tg } from "@/lib/i18n/tg";
import "./globals.css";

export const metadata: Metadata = {
  title: `${tg.app.name} — ${tg.app.subtitle}`,
  description: tg.app.subtitle,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Station screens are used with gloves on a tablet; let people zoom.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tg">
      <body>{children}</body>
    </html>
  );
}
