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
  title: "売れる発信ナビ | SNSから商品と売上をつくる",
  description:
    "発信ジャンルから商品を考え、SNS投稿、売上予測、成果分析までつなぐ操作デモ。",
  openGraph: {
    title: "売れる発信ナビ",
    description: "SNSを、売上の入口にする。",
    type: "website",
    locale: "ja_JP",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "売れる発信ナビ",
    description: "SNSを、売上の入口にする。",
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
