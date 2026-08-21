const JAPANESE_TEXT_PATTERN = /[\u3040-\u30ff\u3400-\u9fff]/u;
const RAW_AUTHENTICATION_ERROR_PATTERN =
  /(?:bad\s*_?\s*request|invalid[_\s-]?request|internal[_\s-]?error|\bdetail\b|unexpected\s+token|<!doctype|<html)/iu;

export class AuthenticationApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(
    message: string,
    { status, code }: { status: number; code?: string },
  ) {
    super(message);
    this.name = "AuthenticationApiError";
    this.status = status;
    this.code = code;
  }
}

export function isTrialAlreadyIssuedAuthenticationError(cause: unknown) {
  return (
    cause instanceof AuthenticationApiError &&
    cause.status === 409 &&
    cause.code === "trial_already_issued"
  );
}

export function authenticationErrorMessage(
  cause: unknown,
  fallback: string,
) {
  const candidate =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "";
  const message = candidate.trim();

  if (
    !message ||
    !JAPANESE_TEXT_PATTERN.test(message) ||
    RAW_AUTHENTICATION_ERROR_PATTERN.test(message)
  ) {
    return fallback;
  }

  return message;
}
