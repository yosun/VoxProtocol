import {describe, expect, it} from "vitest";
import {workerAuthorized} from "../workers/anchor/src/server.js";

describe("anchor worker authentication", () => {
  it("requires the explicit token only in token mode", () => {
    expect(workerAuthorized({"x-vox-worker-token": "expected"}, "token", "expected")).toBe(true);
    expect(workerAuthorized({"x-vox-worker-token": "wrong"}, "token", "expected")).toBe(false);
    expect(workerAuthorized({}, "token", undefined)).toBe(false);
  });

  it("delegates IAM mode to the Cloud Run platform and keeps local none mode open", () => {
    expect(workerAuthorized({}, "iam")).toBe(true);
    expect(workerAuthorized({}, "none")).toBe(true);
  });
});
