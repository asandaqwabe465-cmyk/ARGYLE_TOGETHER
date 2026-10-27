import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Argyle Together | Walk with your neighbours",
  description: "An independent student initiative to coordinate walks with residents of Argyle House, Johannesburg.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {capable: true, title: "Argyle Together", statusBarStyle: "default"},
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/icons/apple-touch-icon.png",
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
