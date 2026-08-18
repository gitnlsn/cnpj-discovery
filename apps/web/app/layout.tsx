import "./globals.css";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Suspense } from "react";
import { Providers } from "@/lib/trpc";
import { AppShell } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

// The variables go on <html>, not <body>: Tailwind v4 resolves @theme at parse
// time, so the classes have to be present on the element the tokens cascade from.
const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "cnpj-discovery",
  description: "Da ideia ao lead qualificado, com dados abertos da Receita Federal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="pt-BR"
      suppressHydrationWarning
      className={cn(geistSans.variable, geistMono.variable)}
    >
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <Providers>
            <TooltipProvider delayDuration={300}>
              {/* useSearchParams in the shell needs a boundary above it. */}
              <Suspense fallback={<div className="h-12 border-b" />}>
                <AppShell>{children}</AppShell>
              </Suspense>
              <Toaster position="bottom-right" />
            </TooltipProvider>
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
