import {
  issueOrRefreshTrialSession,
  TrialSessionIssueError,
} from "../../../../lib/trial-session-store";
import { trialSessionCookie } from "../../../../lib/trial-session";
import { isSameOriginMutation } from "../../../../lib/operator-session";

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return Response.json(
      { error: "この画面からもう一度お試しください。" },
      { status: 403 },
    );
  }
  let sessionId: string;
  try {
    sessionId = await issueOrRefreshTrialSession(request);
  } catch (error) {
    if (error instanceof TrialSessionIssueError) {
      return Response.json(
        { error: error.publicMessage, code: error.code },
        {
          status: error.status,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    throw error;
  }
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
