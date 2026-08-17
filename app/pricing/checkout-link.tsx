"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { trackClientEvent } from "../../lib/client-analytics";
import { MONTHLY_FIRST_OFFER_VERSION } from "../monthly-first-purchase";

type CheckoutPlan = "one_time" | "starter" | "standard";

export default function CheckoutLink({
  plan,
  className,
  children,
}: {
  plan: CheckoutPlan;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      className={className}
      href={`/account?checkout=${plan}`}
      onClick={() =>
        trackClientEvent("checkout_started", {
          plan,
          source: "pricing",
          offer_version: MONTHLY_FIRST_OFFER_VERSION,
        })
      }
    >
      {children}
    </Link>
  );
}
