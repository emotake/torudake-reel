import { AccountAuthError } from "./account-auth";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "./request-safety";

export const MAX_AUTH_BODY_BYTES = 64 * 1024;

export function accountAuthErrorResponse(error: unknown) {
  if (error instanceof AccountAuthError) {
    return privateJson(
      { error: error.publicMessage, code: error.code },
      { status: error.status },
    );
  }
  console.error("account authentication failed", error);
  return privateJson(
    {
      error: "本人確認を完了できませんでした。もう一度お試しください。",
      code: "authentication_failed",
    },
    { status: 400 },
  );
}

export async function readAuthJson(request: Request) {
  try {
    const value = await parseJsonBodyWithLimit<unknown>(
      request,
      MAX_AUTH_BODY_BYTES,
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid body");
    }
    return value;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw new AccountAuthError(
        "authentication_payload_too_large",
        413,
        "認証データが大きすぎます。もう一度お試しください。",
      );
    }
    throw new AccountAuthError(
      "invalid_authentication_payload",
      400,
      "認証データを確認できませんでした。もう一度お試しください。",
    );
  }
}

export function privateJson(
  body: Record<string, unknown>,
  init: ResponseInit = {},
) {
  const response = Response.json(body, init);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}
