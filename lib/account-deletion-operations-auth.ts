import { env } from "cloudflare:workers";

const MINIMUM_SECRET_LENGTH = 32;

type AccountDeletionOperationsEnvironment = {
  ACCOUNT_DELETION_OPERATIONS_SECRET?: string;
};

export function isAccountDeletionOperationsConfigured() {
  return configuredSecret().length >= MINIMUM_SECRET_LENGTH;
}

export async function authorizeAccountDeletionOperations(request: Request) {
  const expected = configuredSecret();
  const supplied = bearerToken(request);
  if (expected.length < MINIMUM_SECRET_LENGTH || !supplied) return false;
  return constantTimeSecretEqual(supplied, expected);
}

function configuredSecret() {
  return (
    env as typeof env & AccountDeletionOperationsEnvironment
  ).ACCOUNT_DELETION_OPERATIONS_SECRET?.trim() ?? "";
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]{1,512})$/i.exec(authorization);
  return match?.[1] ?? "";
}

async function constantTimeSecretEqual(left: string, right: string) {
  const [leftDigest, rightDigest] = await Promise.all([
    digest(left),
    digest(right),
  ]);
  let difference = leftDigest.byteLength ^ rightDigest.byteLength;
  const length = Math.max(leftDigest.byteLength, rightDigest.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return difference === 0;
}

async function digest(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}
