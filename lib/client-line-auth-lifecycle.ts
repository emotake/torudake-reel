export type LineAuthenticationAttemptState = {
  mounted: boolean;
  open: boolean;
  generation: number;
};

export function isActiveLineAuthenticationAttempt(
  state: LineAuthenticationAttemptState,
  expectedGeneration: number,
) {
  return (
    state.mounted &&
    state.open &&
    state.generation === expectedGeneration
  );
}

export function isActiveAbortableAuthenticationAttempt(
  state: LineAuthenticationAttemptState,
  expectedGeneration: number,
  signal: AbortSignal,
) {
  return (
    !signal.aborted &&
    isActiveLineAuthenticationAttempt(state, expectedGeneration)
  );
}

export function claimAuthenticationBusy<T>(
  state: { current: T | null },
  next: T,
) {
  if (state.current !== null) return false;
  state.current = next;
  return true;
}

export function shouldInitializeAuthenticationGate<TMode>(
  initializedMode: TMode | null,
  open: boolean,
  mode: TMode,
) {
  return open && initializedMode !== mode;
}

export type LineSameTabNavigationEpoch = {
  epoch: number;
  generation: number;
  committed: boolean;
};

export function createLineSameTabNavigationEpoch(
  epoch: number,
  generation: number,
): LineSameTabNavigationEpoch {
  return { epoch, generation, committed: false };
}

export function markLineSameTabNavigationCommitted(
  navigation: LineSameTabNavigationEpoch | null,
  expectedEpoch: number,
) {
  if (!navigation || navigation.epoch !== expectedEpoch) return false;
  navigation.committed = true;
  return true;
}

export function isPendingLineSameTabNavigation(
  navigation: LineSameTabNavigationEpoch | null,
  expectedEpoch: number,
  expectedGeneration: number,
) {
  return (
    navigation?.epoch === expectedEpoch &&
    navigation.generation === expectedGeneration &&
    !navigation.committed
  );
}

export async function runGuardedAuthenticationSequence<TOptions, TCredential>({
  isCurrent,
  ensureContext,
  loadOptions,
  requestCredential,
  verifyCredential,
  refreshAuthentication,
}: {
  isCurrent: () => boolean;
  ensureContext: () => Promise<void>;
  loadOptions: () => Promise<TOptions>;
  requestCredential: (options: TOptions) => Promise<TCredential>;
  verifyCredential: (credential: TCredential) => Promise<void>;
  refreshAuthentication: () => Promise<unknown>;
}): Promise<"completed" | "stale"> {
  if (!isCurrent()) return "stale";
  await ensureContext();
  if (!isCurrent()) return "stale";
  const options = await loadOptions();
  if (!isCurrent()) return "stale";
  const credential = await requestCredential(options);
  if (!isCurrent()) return "stale";
  await verifyCredential(credential);
  if (!isCurrent()) return "stale";
  await refreshAuthentication();
  return isCurrent() ? "completed" : "stale";
}

type TimeoutHandle = ReturnType<typeof setTimeout>;

export async function runAbortableAuthenticationRequest<T>({
  timeoutMs,
  timeoutMessage,
  signal: parentSignal,
  run,
  schedule = setTimeout,
  cancel = clearTimeout,
}: {
  timeoutMs: number;
  timeoutMessage: string;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
  schedule?: (callback: () => void, delayMs: number) => TimeoutHandle;
  cancel?: (handle: TimeoutHandle) => void;
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive safe integer.");
  }
  if (!timeoutMessage) {
    throw new TypeError("timeoutMessage is required.");
  }
  if (parentSignal?.aborted) {
    throw (
      parentSignal.reason ??
      new DOMException("The operation was aborted.", "AbortError")
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  const forwardParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };
  parentSignal?.addEventListener("abort", forwardParentAbort, { once: true });

  const handle = schedule(() => {
    timedOut = true;
    if (!controller.signal.aborted) {
      controller.abort(new Error(timeoutMessage));
    }
  }, timeoutMs);
  try {
    const result = await run(controller.signal);
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    return result;
  } catch (error) {
    if (timedOut) throw new Error(timeoutMessage);
    if (parentSignal?.aborted) throw parentSignal.reason;
    throw error;
  } finally {
    cancel(handle);
    parentSignal?.removeEventListener("abort", forwardParentAbort);
  }
}

export function scheduleLineAuthenticationRecovery({
  delayMs,
  isCurrent,
  recover,
  schedule = setTimeout,
  cancel = clearTimeout,
}: {
  delayMs: number;
  isCurrent: () => boolean;
  recover: () => void;
  schedule?: (callback: () => void, delayMs: number) => TimeoutHandle;
  cancel?: (handle: TimeoutHandle) => void;
}) {
  let cancelled = false;
  const handle = schedule(() => {
    if (!cancelled && isCurrent()) recover();
  }, delayMs);
  return () => {
    if (cancelled) return;
    cancelled = true;
    cancel(handle);
  };
}
