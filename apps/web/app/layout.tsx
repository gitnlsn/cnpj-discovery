import "./globals.css";
import type { Metadata } from "next";
import { Providers } from "@/lib/trpc";
import { Tabs } from "@/components/Tabs";

export const metadata: Metadata = {
  title: "cnpj-discovery",
  description: "Da ideia ao lead qualificado, com dados abertos da Receita Federal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <Providers>
          <header className="top">
            <strong>cnpj-discovery</strong>
            <Tabs />
          </header>
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
