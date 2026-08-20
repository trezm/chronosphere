import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono" });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const protocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0] || "http";
  const host = requestHeaders.get("x-forwarded-host")?.split(",")[0] || requestHeaders.get("host") || "localhost:3000";
  const origin = process.env.APP_URL?.replace(/\/$/, "") || `${protocol}://${host}`;
  const title = "Chronosphere — PRs, reconstructed";
  const description = "Replay a pull request as a plausible step-by-step implementation story, then review and merge it on GitHub.";
  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: { icon: "/favicon.svg" },
    openGraph: { title, description, type: "website", images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "Chronosphere — PRs, reconstructed" }] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: `try{const saved=localStorage.getItem("chronosphere-theme");document.documentElement.dataset.theme=saved||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}catch{}` }} /></head><body className={`${inter.variable} ${plexMono.variable}`}>{children}</body></html>;
}
