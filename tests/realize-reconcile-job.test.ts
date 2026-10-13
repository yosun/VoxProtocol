import {describe, expect, it, vi} from "vitest";
import {runRealizeReconciliation} from "../apps/api/src/realize-reconcile-job.js";

describe("Realize reconciliation job", () => {
  it("calls the authenticated internal route with a bounded batch size", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({processed: 2, commissions: [{state: "SETTLED"}, {state: "GENERATING"}]}), {status: 200}));
    const result = await runRealizeReconciliation({VOX_API_URL: "https://vox-api.example.test", VOX_INTERNAL_TOKEN: "a".repeat(40), VOX_REALIZE_RECONCILE_LIMIT: "10"}, fetcher as typeof fetch);
    expect(result).toEqual({processed: 2, failed: 0});
    expect(fetcher).toHaveBeenCalledWith(new URL("https://vox-api.example.test/v1/internal/realize/reconcile"), expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({authorization: `Bearer ${"a".repeat(40)}`}),
      body: JSON.stringify({limit: 10})
    }));
  });

  it("fails the job when the API reports commissions that need retry", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({processed: 1, commissions: [{commission_id: "commission:test", error: "temporary provider failure"}]}), {status: 200}));
    await expect(runRealizeReconciliation({VOX_API_URL: "https://vox-api.example.test", VOX_INTERNAL_TOKEN: "b".repeat(40)}, fetcher as typeof fetch)).resolves.toEqual({processed: 1, failed: 1});
  });

  it("rejects insecure endpoints and malformed credentials", async () => {
    const fetcher = vi.fn();
    await expect(runRealizeReconciliation({VOX_API_URL: "http://vox-api.example.test", VOX_INTERNAL_TOKEN: "c".repeat(40)}, fetcher as typeof fetch)).rejects.toThrow("HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
