import { getTrialSessionId } from "./trial-session";

export type CurrentUser = {
  email: string;
  fullName: string | null;
};

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";

export function getCurrentUser(
  request: Request,
  options: { allowTrial?: boolean } = {},
): CurrentUser | null {
  const email = request.headers
    .get(USER_EMAIL_HEADER)
    ?.trim()
    .toLowerCase();
  if (email?.includes("@")) {
    const encodedName = request.headers.get(USER_FULL_NAME_HEADER);
    const fullName =
      encodedName &&
      request.headers.get(USER_FULL_NAME_ENCODING_HEADER) ===
        "percent-encoded-utf-8"
        ? safeDecode(encodedName)
        : null;
    return { email, fullName };
  }

  if (!options.allowTrial) return null;
  const trialSessionId = getTrialSessionId(request);
  return trialSessionId
    ? {
        email: `trial-${trialSessionId}@anonymous.torudake.invalid`,
        fullName: null,
      }
    : null;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function authenticationRequired() {
  return Response.json(
    {
      error: "続けるにはアカウントへのログインが必要です。",
      code: "authentication_required",
    },
    { status: 401 },
  );
}
