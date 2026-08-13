import type { Metadata } from "next";
import OperationsDashboard from "./operations-dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "運営状況",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nocache: true,
  },
  referrer: "no-referrer",
};

export default function OperationsPage() {
  return <OperationsDashboard />;
}
