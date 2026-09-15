import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { dataSource } from "@/lib/data";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Tokens per ticket", template: "%s · Tokens per ticket" },
  description:
    "What each ticket cost to build with AI coding agents, read from a LiteLLM gateway and tied to tickets by branch name.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const source = dataSource();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full font-sans">
        <div className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-8 sm:px-6 sm:py-12">
          <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-4">
            <Link href="/" className="text-lg font-semibold tracking-tight hover:text-money">
              Tokens per ticket
            </Link>
            <p
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                source === "sample" ? "bg-warn-soft text-warn" : "bg-money-soft text-money"
              }`}
            >
              {source === "sample" ? "Sample data" : "Live · LiteLLM"}
            </p>
          </header>
          {children}
          <footer className="border-t border-rule pt-4 text-xs text-ink-soft">
            Spend comes from LiteLLM&apos;s daily tag totals. Each Claude Code call is tagged with the ticket of the
            session&apos;s current branch. See the README for how it fits together.
          </footer>
        </div>
      </body>
    </html>
  );
}
