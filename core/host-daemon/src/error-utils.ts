interface ErrorSummary {
  errorMessage: string;
  errorName: string;
}

export function normalizeCaughtError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function summarizeError(error: unknown): ErrorSummary {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorName: error.name,
    };
  }

  return {
    errorMessage: String(error),
    errorName: "NonError",
  };
}

export function runtimeErrorLogFields(
  error: unknown,
): { err: unknown } | ErrorSummary {
  return process.env.NODE_ENV === "production"
    ? summarizeError(error)
    : { err: error };
}
