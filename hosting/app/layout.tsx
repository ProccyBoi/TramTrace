import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TramTrace — Sydney light rail live map",
  description:
    "Live Sydney light rail data for the physical TramTrace LED map.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
