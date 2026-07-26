import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "声ストック｜SNSのうれしい声を、売れる証拠に。",
  description:
    "Instagram・Threads・Xのコメントを、許諾付きのお客さまの声に変えるサービスのデモです。",
  openGraph: {
    title: "声ストック｜SNSのうれしい声を、売れる証拠に。",
    description:
      "コメント収集・掲載許諾・販売ページへの公開・効果分析までを一つに。",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
