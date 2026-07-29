import { headers } from "next/headers";

export type ChatGPTUser = {
  displayName: string;
  email: string;
  fullName: string | null;
};

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  if (!email) return null;

  const encodedFullName = requestHeaders.get(
    "oai-authenticated-user-full-name",
  );
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? safeDecode(encodedFullName)
      : null;

  return {
    displayName: fullName ?? email,
    email,
    fullName,
  };
}

export function chatGPTSignInPath(returnTo: string) {
  return `/signin-with-chatgpt?return_to=${encodeURIComponent(
    safeReturnPath(returnTo),
  )}`;
}

export function chatGPTSignOutPath(returnTo = "/") {
  return `/signout-with-chatgpt?return_to=${encodeURIComponent(
    safeReturnPath(returnTo),
  )}`;
}

function safeReturnPath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://app.local");
    if (url.origin !== "https://app.local") return "/";
    if (
      ["/signin-with-chatgpt", "/signout-with-chatgpt", "/callback"].includes(
        url.pathname,
      )
    ) {
      return "/";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
