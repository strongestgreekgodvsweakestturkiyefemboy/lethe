import type { Metadata } from "next";
import "./globals.css";
import NavBar from "@/components/NavBar";
import { AuthProvider } from "@/components/AuthContext";
import ThemeInitializer from "@/components/ThemeInitializer";
import siteConfig from "@/site.config";

export const metadata: Metadata = {
  title: siteConfig.siteName,
  description: siteConfig.siteTagline,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <AuthProvider>
          <ThemeInitializer />
          <NavBar>{children}</NavBar>
        </AuthProvider>
      </body>
    </html>
  );
}
