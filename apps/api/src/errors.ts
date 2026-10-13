export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class UsernameConflict extends Error {
  readonly username: string;

  constructor(username: string, message = `username "${username}" is already claimed`) {
    super(message);
    this.name = "UsernameConflict";
    this.username = username;
  }
}

type ProviderError = {code?: unknown};

export function dependencyHttpError(error: unknown): HttpError | undefined {
  const providerCode = (error as ProviderError | null)?.code;
  const numericCode = typeof providerCode === "number" ? providerCode : Number(providerCode);
  const namedCode = typeof providerCode === "string" ? providerCode.toUpperCase() : "";

  if (numericCode === 9 || namedCode === "FAILED_PRECONDITION") {
    return new HttpError(503, "storage_query_unavailable", "data storage query is temporarily unavailable");
  }
  if ([4, 8, 13, 14].includes(numericCode) || ["DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE"].includes(namedCode)) {
    return new HttpError(503, "storage_unavailable", "data storage is temporarily unavailable");
  }
  if (numericCode === 7 || namedCode === "PERMISSION_DENIED") {
    return new HttpError(500, "storage_misconfigured", "data storage is not configured correctly");
  }
  return undefined;
}
