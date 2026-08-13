import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { verifyRegistration } from "../../../../../../lib/account-auth";
import {
  accountAuthErrorResponse,
  privateJson,
  readAuthJson,
} from "../../../../../../lib/account-auth-http";
import { isSameOriginMutation } from "../../../../../../lib/operator-session";

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson(
      { error: "この画面からもう一度お試しください。", code: "invalid_request_origin" },
      { status: 403 },
    );
  }
  try {
    const payload = await readAuthJson(request);
    const wrappedCredential = "credential" in payload ? payload.credential : payload;
    if (!wrappedCredential || typeof wrappedCredential !== "object") {
      throw new Error("Passkey credential is missing.");
    }
    const result = await verifyRegistration(
      request,
      wrappedCredential as RegistrationResponseJSON,
      "credential" in payload && "displayName" in payload
        ? payload.displayName
        : undefined,
    );
    const response = privateJson({ authenticated: true });
    response.headers.append("Set-Cookie", result.sessionCookie);
    response.headers.append("Set-Cookie", result.challengeCookie);
    return response;
  } catch (error) {
    return accountAuthErrorResponse(error);
  }
}
