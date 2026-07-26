import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    "https://revenuepilot-demo-jp.emotake-1027-a.chatgpt.site",
  ),
  title: "案件レスキュー | PR案件の条件確認から入金まで",
  description:
    "インフルエンサー向け。DMや契約書からPR案件の見落とし、交渉ポイント、返信文を整理する操作デモ。",
  openGraph: {
    title: "案件レスキュー",
    description: "そのPR案件、受けて大丈夫？",
    type: "website",
    locale: "ja_JP",
    images: [{ url: "/og.png", width: 1792, height: 896 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "案件レスキュー",
    description: "PR案件の条件確認から、交渉・入金まで。",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
