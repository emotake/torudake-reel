import {
  getOperatorDevice,
  isOperatorEnrollmentConfigured,
} from "../../../../lib/operator-access";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const configured = isOperatorEnrollmentConfigured();
  const device = configured ? await getOperatorDevice(request) : null;
  const response = Response.json({
    configured,
    registered: Boolean(device),
    label: device?.label ?? null,
    activatedAt: device?.activatedAt ?? null,
    expiresAt: device?.expiresAt ?? null,
  });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.headers.set("Vary", "Cookie");
  return response;
}
