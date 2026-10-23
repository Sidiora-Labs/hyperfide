const DEFAULT_TIMEOUT_SCALE = 1;

function readTimeoutScale(): number {
  const parsed = Number(
    process.env.BB_TEST_TIMEOUT_SCALE ?? DEFAULT_TIMEOUT_SCALE,
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_SCALE;
  }
  return parsed;
}

export function scaleTimeoutMs(timeoutMs: number): number {
  return Math.ceil(timeoutMs * readTimeoutScale());
}
