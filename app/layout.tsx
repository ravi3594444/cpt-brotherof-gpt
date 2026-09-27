import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Scout — Your web, understood",
  description:
    "Follow your curiosity. Search the web, read sources, and find clearer answers with Scout.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  appleWebApp: {
    capable: true,
    title: "Scout",
    statusBarStyle: "black-translucent",
  },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#171819",
  viewportFit: "cover",
  // Android: shrink the page when the keyboard opens so the question box stays visible.
  interactiveWidget: "resizes-content",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;450;500;550;600;650;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
