import type { Metadata } from "next";
import OperatorDeviceClient from "./operator-device-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "端末登録",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nocache: true,
  },
  referrer: "no-referrer",
};

export default function OperatorDevicePage() {
  return <OperatorDeviceClient />;
}
