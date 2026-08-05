import type { Metadata } from "next";
import AccountClient from "./account-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "アカウント｜撮るだけリール",
  description: "撮るだけリールの利用枠とお支払いを管理します。",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nocache: true,
  },
};

export default function AccountPage() {
  return <AccountClient />;
}
