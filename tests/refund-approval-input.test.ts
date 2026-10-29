import {describe, expect, it} from "vitest";
import {parseSecretJson} from "../scripts/secret-json.mjs";

describe("refund operator credential parsing", () => {
  it("parses a valid identity bundle without logging it", () => {
    expect(parseSecretJson('{"format":"test-only"}', "Operator identity")).toEqual({format:"test-only"});
  });
  it.each(['SENSITIVE!', '{"key_material":"synthetic-secret"', 'not-json-secret-fixture'])('suppresses parser input excerpts for malformed secret JSON', (value) => {
    let error: Error | undefined;
    try { parseSecretJson(value, "Operator identity"); } catch (caught) { error = caught as Error; }
    expect(error?.message).toBe("Operator identity could not be decoded as JSON");
    expect(error?.stack).not.toContain(value);
    expect(error?.cause).toBeUndefined();
  });
});
