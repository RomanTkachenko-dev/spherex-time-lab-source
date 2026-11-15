import type { Metadata } from "next";
import "./globals.css";
import "./observatory.css";

export const metadata: Metadata = {
  title: "SPHEREx Time Lab: the sky in motion",
  description: "Compare real NASA SPHEREx infrared exposures of the same patch of sky over time.",
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
