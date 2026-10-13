import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {HttpPopuliRealizeClient, type RealizeCreatorPayoutConfigurationV1} from "../apps/api/src/realize-engine.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../packages/protocol/fixtures/realize/${name}`, import.meta.url), "utf8"));
const configuration = {
  populi_api_base_url: "https://populi.example.test",
  populi_api_token_env: "VOX_TEST_POPULI_API_TOKEN"
} as RealizeCreatorPayoutConfigurationV1;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VOX_TEST_POPULI_API_TOKEN;
});

describe("Populi Realize HTTP client", () => {
  it("loads a configured schema and its creator query while refusing other origins or creators", async () => {
    process.env.VOX_TEST_POPULI_API_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({type: "object", properties: {concept: {type: "string"}}}), {status: 200}));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpPopuliRealizeClient();
    await expect(client.getInputSchema(configuration, "https://untrusted.example.test/v1/realize/schemas/video", "creator:bob")).rejects.toThrow(/configured Realize schema origin/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(client.getInputSchema(configuration, "https://populi.example.test/v1/realize/schemas/video?creator_id=creator:other", "creator:bob")).rejects.toThrow(/unsupported or mismatched query/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(client.getInputSchema(configuration, "https://populi.example.test/v1/realize/schemas/video?creator_id=creator%3Abob", "creator:bob")).resolves.toHaveProperty("type", "object");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://populi.example.test/v1/realize/schemas/video?creator_id=creator%3Abob");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer test-token");
  });

  it("uses the pricing request ID as the required idempotency key", async () => {
    process.env.VOX_TEST_POPULI_API_TOKEN = "test-token";
    const response = fixture("provider-price.response.json");
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(response), {status: 200}));
    vi.stubGlobal("fetch", fetchMock);

    const request = fixture("provider-pricing.request.json");
    await new HttpPopuliRealizeClient().getCurrentPrice(configuration, request);

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(request.request_id);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
  });

  it("uses the fulfillment idempotency key for externally funded submission", async () => {
    process.env.VOX_TEST_POPULI_API_TOKEN = "test-token";
    const response = fixture("fulfillment-completed.result.json");
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(response), {status: 200}));
    vi.stubGlobal("fetch", fetchMock);

    const request = fixture("provider-fulfillment.request.json");
    await new HttpPopuliRealizeClient().requestFulfillment(configuration, request);

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(request.idempotency_key);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
  });
});
