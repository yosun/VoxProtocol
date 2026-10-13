import { utf8 } from "./encoding.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`Canonical JSON only accepts finite integers at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error(`Canonical JSON rejects non-plain objects at ${path}`);
    }
    for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${path}.${key}`);
    return;
  }
  throw new Error(`Canonical JSON rejects ${typeof value} at ${path}`);
}

/**
 * A deliberately restricted RFC 8785-compatible serializer. Vox signed objects
 * contain strings, booleans, integers, arrays and plain objects only.
 */
export function canonicalize(value: unknown): string {
  assertJsonValue(value, "$" );
  return serialize(value);
}

function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => serialize(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${serialize(value[key]!)}`).join(",")}}`;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8(canonicalize(value));
}
