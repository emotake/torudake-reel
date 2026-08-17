import {
  deleteAccountPasskey,
  getAccountPasskeys,
  renameAccountPasskey,
  requirePasskeyAuthenticationAvailable,
} from "../../../../lib/account-auth";
import {
  accountAuthErrorResponse,
  privateJson,
  readAuthJson,
} from "../../../../lib/account-auth-http";
import { isSameOriginMutation } from "../../../../lib/operator-session";

export async function GET(request: Request) {
  try {
    requirePasskeyAuthenticationAvailable();
    return privateJson({ passkeys: await getAccountPasskeys(request) });
  } catch (error) {
    return accountAuthErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    requirePasskeyAuthenticationAvailable();
    if (!isSameOriginMutation(request)) return invalidOrigin();
    const payload = await readAuthJson(request);
    const result = await renameAccountPasskey(
      request,
      "id" in payload ? payload.id : undefined,
      "displayName" in payload ? payload.displayName : undefined,
    );
    return privateJson({ updated: true, ...result });
  } catch (error) {
    return accountAuthErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    requirePasskeyAuthenticationAvailable();
    if (!isSameOriginMutation(request)) return invalidOrigin();
    const payload = await readAuthJson(request);
    const result = await deleteAccountPasskey(
      request,
      "id" in payload ? payload.id : undefined,
    );
    return privateJson({ deleted: true, ...result });
  } catch (error) {
    return accountAuthErrorResponse(error);
  }
}

function invalidOrigin() {
  return privateJson(
    { error: "この画面からもう一度お試しください。", code: "invalid_request_origin" },
    { status: 403 },
  );
}
