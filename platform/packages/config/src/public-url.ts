export function validateOptionalUrl(name: string, value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return "";
  }
  return validateRequiredUrl(name, trimmedValue);
}

export function validateRequiredUrl(name: string, value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    throw new Error(`${name} must not be empty`);
  }

  try {
    void new URL(trimmedValue);
    return trimmedValue;
  } catch {
    throw new Error(`${name} must be a valid URL, received "${value}"`);
  }
}
