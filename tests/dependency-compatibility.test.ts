import {createRequire} from "node:module";
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {z} from "zod";
import {Connection, PublicKey} from "@solana/web3.js";
import {u64, u128, u256} from "@solana/buffer-layout-utils";
import {AccountLayout} from "@solana/spl-token";
import {GenerationParametersV1Schema, ProviderPriceQuoteV1Schema, RealizeQuoteV1Schema} from "@vox/protocol";
import * as protocol from "@vox/protocol";

const require = createRequire(import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../packages/protocol/fixtures/realize/${name}`, import.meta.url), "utf8"));

describe("security dependency compatibility", () => {
  it("rejects an oversized constrained collection before validating its elements", () => {
    let visited = 0;
    const element = z.preprocess((value) => { visited += 1; return value; }, z.string());
    const result = z.array(element).max(64).safeParse(Array(100_000).fill("bounded"));
    expect(result.success).toBe(false);
    expect(visited).toBe(0);
    expect(GenerationParametersV1Schema.safeParse({references: Array(65).fill("image")})).toMatchObject({success: false});
  });

  it("retains shared signed-fixture validation and strict generated schema bounds on Zod 4", () => {
    const quote = fixture("bob-one-dollar-special-video.quote.json");
    const price = fixture("provider-price.response.json");
    expect(RealizeQuoteV1Schema.parse(quote)).toEqual(quote);
    expect(ProviderPriceQuoteV1Schema.parse(price)).toEqual(price);
    expect(RealizeQuoteV1Schema.safeParse({...quote, total_amount_usdc_atomic: "18446744073709551616"}).success).toBe(false);
    const Ajv2020 = require("ajv/dist/2020.js").default;
    const schema = JSON.parse(readFileSync(new URL("../packages/protocol/schemas/realize-v1.schema.json", import.meta.url), "utf8"));
    const ajv = new Ajv2020({strict: false, validateFormats: false});
    ajv.addSchema(schema);
    for (const [name, file] of [
      ["RealizeQuote", "bob-one-dollar-special-video.quote.json"],
      ["RealizeQuote", "multiple-payout-recipients.quote.json"],
      ["SettlementInstruction", "multiple-payout-recipients.settlement.json"],
      ["ProviderPricingRequest", "provider-pricing.request.json"],
      ["ProviderPriceQuote", "provider-price.response.json"],
      ["ProviderFulfillmentRequest", "provider-fulfillment.request.json"],
      ["FulfillmentResult", "fulfillment-completed.result.json"],
      ["ProvenanceRecord", "provenance-record.json"],
      ["RevenueRightsAgreement", "commissioner-revenue-participation.json"]
    ] as const) {
      const value = fixture(file);
      expect(protocol[`${name}V1Schema`].parse(value)).toEqual(value);
      const validate = ajv.compile({$ref: `${schema.$id}#/$defs/${name}`});
      expect(validate(value), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    const validator = ajv.compile({$ref: `${schema.$id}#/$defs/RealizeQuote`});
    expect(validator(quote)).toBe(true);
    expect(validator({...quote, extra_field: true})).toBe(false);
    expect(validator({...quote, total_amount_usdc_atomic: "18446744073709551616"})).toBe(false);
  });

  it("uses the reviewed pure JavaScript bigint conversion for fixed-width Solana token layouts", () => {
    const layoutRequire = createRequire(require.resolve("@solana/buffer-layout-utils"));
    const resolved = layoutRequire.resolve("bigint-buffer/package.json");
    const metadata = JSON.parse(readFileSync(resolved, "utf8"));
    expect(metadata.name).toBe("@exodus/bigint-buffer");
    expect(metadata.dependencies ?? {}).toEqual({});
    expect(metadata.scripts?.install).toBeUndefined();
    const conversions = layoutRequire("bigint-buffer");
    for (const [bytes, layout] of [[8, u64()], [16, u128()], [32, u256()]] as const) {
      for (const value of [0n, 1n, (1n << BigInt(bytes * 8)) - 1n]) {
        const little = conversions.toBufferLE(value, bytes);
        const big = conversions.toBufferBE(value, bytes);
        expect(conversions.toBigIntLE(little)).toBe(value);
        expect(conversions.toBigIntBE(big)).toBe(value);
        const encoded = Buffer.alloc(bytes);
        expect(layout.encode(value, encoded, 0)).toBe(bytes);
        expect(encoded).toEqual(little);
        expect(layout.decode(encoded, 0)).toBe(value);
      }
    }
    const account = Buffer.alloc(AccountLayout.span);
    account.writeBigUInt64LE(0xffffffffffffffffn, 64);
    expect(AccountLayout.decode(account).amount).toBe(0xffffffffffffffffn);
    const oversized = Buffer.alloc(513, 0x5a);
    const original = Buffer.from(oversized);
    expect(conversions.toBigIntLE(oversized)).toBe(BigInt(`0x${Buffer.from(oversized).reverse().toString("hex")}`));
    expect(oversized).toEqual(original);
  });

  it("retains the v4 UUID API used by Google clients through their own dependency resolution", () => {
    for (const dependency of ["google-gax", "gaxios", "teeny-request"]) {
      const clientRequire = createRequire(require.resolve(dependency));
      const uuid = clientRequire("uuid");
      expect(clientRequire("uuid/package.json").version).toBe("11.1.1");
      expect(uuid.v4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("preserves web3's single and batch HTTP RPC contracts with Jayson 5", async () => {
    const requests: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const response = (item: {id: string; method: string}) => ({jsonrpc: "2.0", id: item.id, result: item.method === "getBalance" ? {context: {slot: 3}, value: 123} : null});
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(response) : response(body)), {status: 200, headers: {"content-type": "application/json"}});
    };
    const connection = new Connection("http://127.0.0.1:1", {fetch, httpAgent: false});
    await expect(connection.getBalance(new PublicKey("11111111111111111111111111111111"))).resolves.toBe(123);
    await expect(connection.getParsedTransactions(["signature:one", "signature:two"], {maxSupportedTransactionVersion: 0})).resolves.toEqual([null, null]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({jsonrpc: "2.0", method: "getBalance"});
    expect(Array.isArray(requests[1])).toBe(true);
  });
});
