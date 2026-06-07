import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claudia",
  description: "Local AI second brain",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{ height: "100%" }}>
      <body style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {children}
      </body>
    </html>
  );
}
