import {describe, expect, it} from "vitest";
import {MockMediaProvider} from "@vox/media-provider";

describe("provider-independent realization contract", () => {
  it("quotes and links a mock job without claiming production video", async () => {
    const provider = new MockMediaProvider();
    const quote = await provider.quote({post_id: "vox:post:" + "11".repeat(32), style: "cinematic", duration_seconds: 12, requester_id: "viewer"});
    const job = await provider.requestGeneration({quote_id: quote.quote_id, post_id: quote.post_id, payment_reference: "mock-payment", requester_id: "viewer"});
    expect(quote.mock).toBe(true);
    expect(job.status).toBe("delivered");
    expect((await provider.status(job.job_id)).media_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
