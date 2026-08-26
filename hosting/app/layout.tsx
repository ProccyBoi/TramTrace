import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    "https://tramtrace-sydney-live.chatgptbolt.chatgpt.site",
  ),
  title: "TramTrace — Sydney light rail live map",
  description:
    "Live Sydney light rail data for the physical TramTrace LED map.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    type: "website",
    title: "TramTrace",
    description: "Sydney light rail, live on your wall.",
    images: [
      {
        url: "/og.png",
        width: 1731,
        height: 909,
        alt: "TramTrace illuminated Sydney light rail map",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "TramTrace",
    description: "Sydney light rail, live on your wall.",
    images: ["/og.png"],
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
