import { OidcProtocolError } from "./oidc-core";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type JsonObject = Record<string, unknown>;

const LINE_PROVIDER_TIMEOUT_MS = 10_000;
const LINE_CHANNEL_TOKEN_RESPONSE_LIMIT_BYTES = 16 * 1024;
const LINE_DEAUTHORIZATION_RESPONSE_LIMIT_BYTES = 4 * 1024;

export const LINE_DEAUTHORIZATION_ENDPOINTS = {
  channelToken: "https://api.line.me/oauth2/v3/token",
  deauthorize: "https://api.line.me/user/v1/deauthorize",
} as const;

/**
 * Removes the LINE authorization while the freshly-issued user access token is
 * still available. Neither the user token nor the stateless channel token is
 * persisted or returned to the caller.
 */
export async function deauthorizeLineAuthorization(
  values: {
    channelId: string;
    channelSecret: string;
    userAccessToken: string;
  },
  fetcher: FetchLike = fetch,
) {
  assertCredential(values.channelId, 4, 512);
  assertCredential(values.channelSecret, 8, 2_048);
  assertCredential(values.userAccessToken, 8, 8_192);

  const channelTokenResponse = await lineFetch(
    fetcher,
    LINE_DEAUTHORIZATION_ENDPOINTS.channelToken,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: values.channelId,
        client_secret: values.channelSecret,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(LINE_PROVIDER_TIMEOUT_MS),
    },
    "line_channel_token_unavailable",
  );
  const channelTokenPayload = await readBoundedJsonObject(
    channelTokenResponse,
    LINE_CHANNEL_TOKEN_RESPONSE_LIMIT_BYTES,
  );
  if (!channelTokenResponse.ok) {
    throw new OidcProtocolError("line_channel_token_rejected");
  }
  const channelAccessToken = boundedString(
    channelTokenPayload.access_token,
    8,
    8_192,
  );
  const tokenType = boundedString(channelTokenPayload.token_type, 1, 32);
  const expiresIn = channelTokenPayload.expires_in;
  if (
    !channelAccessToken ||
    tokenType?.toLowerCase() !== "bearer" ||
    !Number.isSafeInteger(expiresIn) ||
    (expiresIn as number) < 1 ||
    (expiresIn as number) > 3_600
  ) {
    throw new OidcProtocolError("invalid_line_channel_token_response");
  }

  const deauthorizationResponse = await lineFetch(
    fetcher,
    LINE_DEAUTHORIZATION_ENDPOINTS.deauthorize,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${channelAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userAccessToken: values.userAccessToken }),
      redirect: "error",
      signal: AbortSignal.timeout(LINE_PROVIDER_TIMEOUT_MS),
    },
    "line_deauthorization_unavailable",
  );
  await readBoundedBytes(
    deauthorizationResponse,
    LINE_DEAUTHORIZATION_RESPONSE_LIMIT_BYTES,
  );
  if (deauthorizationResponse.status !== 204) {
    throw new OidcProtocolError("line_deauthorization_rejected");
  }
}

async function lineFetch(
  fetcher: FetchLike,
  endpoint: string,
  init: RequestInit,
  unavailableCode: string,
) {
  try {
    return await fetcher(endpoint, init);
  } catch {
    throw new OidcProtocolError(unavailableCode);
  }
}

async function readBoundedJsonObject(response: Response, maximumBytes: number) {
  const bytes = await readBoundedBytes(response, maximumBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OidcProtocolError("invalid_line_provider_response");
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as JsonObject;
  } catch {
    throw new OidcProtocolError("invalid_line_provider_response");
  }
}

async function readBoundedBytes(response: Response, maximumBytes: number) {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const declaredLength = Number(rawLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maximumBytes
    ) {
      await response.body?.cancel("line_provider_response_too_large").catch(
        () => undefined,
      );
      throw new OidcProtocolError("line_provider_response_too_large");
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("line_provider_response_too_large").catch(
          () => undefined,
        );
        throw new OidcProtocolError("line_provider_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertCredential(value: string, minimum: number, maximum: number) {
  if (!boundedString(value, minimum, maximum)) {
    throw new OidcProtocolError("invalid_line_deauthorization_input");
  }
}

function boundedString(value: unknown, minimum: number, maximum: number) {
  return typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}
