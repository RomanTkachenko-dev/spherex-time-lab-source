import type { Metadata } from "next";
import "./globals.css";
import "./observatory.css";

export const metadata: Metadata = {
  title: "SPHEREx Time Lab — the sky in motion",
  description: "Real SPHEREx observations over time. Play exposures of any sky field and trace every frame back to its archive source.",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
