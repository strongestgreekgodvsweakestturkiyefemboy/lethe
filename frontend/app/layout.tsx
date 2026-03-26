import type { Metadata } from "next";
import "./globals.css";
import NavBar from "@/components/NavBar";
import { AuthProvider } from "@/components/AuthContext";

export const metadata: Metadata = {
  title: "Lethe",
  description: "Self-hosted data archival service",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-gray-950 text-white">
        <AuthProvider>
          <NavBar>{children}</NavBar>
        </AuthProvider>
      </body>
    </html>
  );
}
