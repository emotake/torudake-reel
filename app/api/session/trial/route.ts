import {
  getTrialSessionId,
  trialSessionCookie,
} from "../../../../lib/trial-session";

export async function POST(request: Request) {
  const sessionId = getTrialSessionId(request) ?? crypto.randomUUID();
  const response = Response.json({ ready: true });
  response.headers.set(
    "Set-Cookie",
    trialSessionCookie(
      sessionId,
      new URL(request.url).protocol === "https:",
    ),
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
