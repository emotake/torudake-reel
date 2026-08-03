export function usageDurationToleranceSeconds(reservedSeconds: number) {
  const safeReserved = Math.max(1, Math.ceil(reservedSeconds));
  return Math.min(3, Math.max(1, safeReserved * 0.02));
}

export function isDurationWithinReservation(
  observedSeconds: number,
  reservedSeconds: number,
) {
  if (!Number.isFinite(observedSeconds) || observedSeconds <= 0) return false;
  if (!Number.isFinite(reservedSeconds) || reservedSeconds <= 0) return false;
  return (
    observedSeconds <=
    reservedSeconds + usageDurationToleranceSeconds(reservedSeconds)
  );
}

export function narrationScriptCharacterLimit(reservedSeconds: number) {
  if (!Number.isFinite(reservedSeconds) || reservedSeconds <= 0) return 0;
  // Generated Japanese narration targets roughly 4-5 characters per second.
  // This margin permits punctuation and natural corrections without allowing a
  // one-second reservation to synthesize an arbitrarily long script.
  return Math.min(2_000, Math.max(30, Math.ceil(reservedSeconds * 5.5 + 24)));
}
