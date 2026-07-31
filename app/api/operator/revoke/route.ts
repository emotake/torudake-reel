import {
  clearOperatorSessionCookie,
  isSameOriginMutation,
  revokeOperatorDevice,
} from "../../../../lib/operator-access";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson(
      { error: "登録を解除できませんでした。" },
      { status: 403 },
    );
  }

  const revoked = await revokeOperatorDevice(request);
  const response = privateJson({ revoked });
  response.headers.set(
    "Set-Cookie",
    clearOperatorSessionCookie(
      new URL(request.url).protocol === "https:",
    ),
  );
  return response;
}

function privateJson(
  body: Record<string, unknown>,
  init: ResponseInit = {},
) {
  const response = Response.json(body, init);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.headers.set("Vary", "Cookie");
  return response;
}
