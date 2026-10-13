export const VOX_USERNAME_PATTERN = /^[a-z0-9_]{1,15}$/;
export const VOX_USERNAME_MAX_LENGTH = 15;

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidUsername(value: string): boolean {
  return VOX_USERNAME_PATTERN.test(value);
}
