import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "30秒ジャッジ｜迷ったら、30人に聞いて決める。",
  description:
    "投稿画像・文章・商品案を二択で質問。暇な30秒の回答から、迷いを数字で解消するサービスの体験デモです。",
  openGraph: {
    title: "30秒ジャッジ｜迷ったら、30人に聞いて決める。",
    description:
      "フォロワー0でも、平均12分で30回答。感覚ではなく反応を見て決める。",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "30秒ジャッジ｜迷ったら、30人に聞いて決める。",
    description: "暇な30秒を、誰かの「決められない」に。",
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
