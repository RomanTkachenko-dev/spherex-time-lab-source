import type { Metadata } from "next";
import "./globals.css";
import "./observatory.css";

export const metadata: Metadata = {
  title: "SPHEREx Time Lab — небо в русі",
  description: "Реальні спостереження SPHEREx у часі. Переглядайте кадри й перевіряйте походження даних.",
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
    <html lang="uk">
      <body className="antialiased">{children}</body>
    </html>
  );
}
