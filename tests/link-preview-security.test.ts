import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createServer} from "node:http";
import {EventEmitter} from "node:events";
import {Readable} from "node:stream";

const transport = vi.hoisted(() => ({lookup: vi.fn(), request: vi.fn()}));
vi.mock("node:dns/promises", () => ({lookup: transport.lookup}));
vi.mock("node:http", async (importOriginal) => ({...await importOriginal<typeof import("node:http")>(), request: transport.request}));
vi.mock("node:https", async (importOriginal) => ({...await importOriginal<typeof import("node:https")>(), request: transport.request}));
import {resolveLinkPreview} from "../apps/api/src/link-preview.js";

function response(body = "<title>Public destination</title>", statusCode = 200, headers: Record<string, string> = {"content-type": "text/html"}) {
  return Object.assign(Readable.from([Buffer.from(body)]), {statusCode, headers});
}
function mockRequest(makeResponse: (url: URL, options: any) => Readable) {
  transport.request.mockImplementation((url: URL, options: any, callback: (response: Readable) => void) => {
    const request = new EventEmitter() as EventEmitter & {end: () => void};
    request.end = () => callback(makeResponse(url, options));
    return request;
  });
}
beforeEach(() => {
  transport.lookup.mockReset().mockResolvedValue([{address: "8.8.8.8", family: 4}]);
  transport.request.mockReset();
  mockRequest(() => response());
});
afterEach(() => { vi.restoreAllMocks(); });

describe("link preview network boundaries", () => {
  it("never fetches private IPv4 addresses expressed as hexadecimal mapped IPv6", async () => {
    for (const address of ["::ffff:7f00:1", "::ffff:a00:1", "::ffff:ac10:1", "::ffff:c0a8:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:1", "::ffff:127.0.0.1"]) {
      const preview = await resolveLinkPreview(`http://[${address}]:39001/private`);
      expect(preview?.title).not.toBe("Public destination");
    }
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("blocks the demonstrated mapped-loopback request before it reaches a local server", async () => {
    let received = 0;
    const server = createServer((_request, incomingResponse) => {
      received += 1;
      incomingResponse.writeHead(200, {"content-type": "text/html"});
      incomingResponse.end("<title>Private loopback sentinel</title>");
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a TCP address");
      const preview = await resolveLinkPreview(`http://[::ffff:7f00:1]:${address.port}/`);
      expect(received).toBe(0);
      expect(transport.request).not.toHaveBeenCalled();
      expect(preview?.title).not.toBe("Private loopback sentinel");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("continues fetching mapped public IPv4 destinations", async () => {
    const preview = await resolveLinkPreview("http://[::ffff:808:808]/audit-public");
    expect(transport.request).toHaveBeenCalledOnce();
    expect(transport.lookup).not.toHaveBeenCalled();
    expect(preview?.title).toBe("Public destination");
  });

  it("pins the validated DNS answer through connection lookup while keeping HTTPS hostname verification", async () => {
    transport.lookup.mockResolvedValueOnce([{address: "8.8.8.8", family: 4}]).mockResolvedValue([{address: "127.0.0.1", family: 4}]);
    const connectedAddresses: unknown[] = [];
    mockRequest((url, options) => {
      expect(url.href).toBe("https://dns-switch.test/private");
      expect(options.agent).toBe(false);
      expect(options.family).toBe(4);
      expect(options.servername).toBe("dns-switch.test");
      expect(options.rejectUnauthorized).not.toBe(false);
      expect(options.checkServerIdentity).toBeUndefined();
      expect(options.signal).toBeInstanceOf(AbortSignal);
      options.lookup("dns-switch.test", {}, (_error: unknown, address: string, family: number) => connectedAddresses.push({address, family}));
      options.lookup("dns-switch.test", {all: true}, (_error: unknown, addresses: unknown) => connectedAddresses.push(addresses));
      return response();
    });
    const preview = await resolveLinkPreview("https://dns-switch.test/private");
    expect(preview?.title).toBe("Public destination");
    expect(transport.lookup).toHaveBeenCalledOnce();
    expect(connectedAddresses).toEqual([{address: "8.8.8.8", family: 4}, [{address: "8.8.8.8", family: 4}]]);
  });

  it("revalidates and pins every ordinary redirect hop", async () => {
    transport.lookup.mockResolvedValueOnce([{address: "8.8.8.8", family: 4}]).mockResolvedValueOnce([{address: "9.9.9.9", family: 4}]);
    const destinations: string[] = [];
    mockRequest((url, options) => {
      options.lookup(url.hostname, {}, (_error: unknown, address: string) => destinations.push(address));
      return url.hostname === "redirect-one.test" ? response("", 302, {location: "https://redirect-two.test/target"}) : response("<title>Redirect destination</title>");
    });
    const preview = await resolveLinkPreview("https://redirect-one.test/start");
    expect(preview?.title).toBe("Redirect destination");
    expect(preview?.canonicalUrl).toBe("https://redirect-two.test/target");
    expect(destinations).toEqual(["8.8.8.8", "9.9.9.9"]);
    expect(transport.lookup.mock.calls.map((call) => call[0])).toEqual(["redirect-one.test", "redirect-two.test"]);
  });

  it("rejects a redirect to a private or mapped-private destination before the next connection", async () => {
    mockRequest(() => response("", 302, {location: "https://private-redirect.test/admin"}));
    transport.lookup.mockResolvedValueOnce([{address: "8.8.8.8", family: 4}]).mockResolvedValueOnce([{address: "0:0:0:0:0:ffff:7f00:1", family: 6}]);
    const preview = await resolveLinkPreview("https://public-redirect.test/start");
    expect(preview?.title).toBe("public-redirect.test");
    expect(transport.request).toHaveBeenCalledOnce();
  });

  it("rejects mixed public/private DNS answers and expanded private IPv6", async () => {
    for (const [index, privateAddress] of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:a00:1", "fd00::1", "fe80::1"].entries()) {
      transport.lookup.mockResolvedValueOnce([{address: "8.8.8.8", family: 4}, {address: privateAddress, family: privateAddress.includes(":") ? 6 : 4}]);
      await resolveLinkPreview(`https://mixed-dns-${index}.test/`);
    }
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("keeps the response byte limit and redirect limit", async () => {
    mockRequest(() => response(`<title>Too large</title>${"x".repeat(512 * 1024)}`));
    const oversized = await resolveLinkPreview("https://oversized-preview.test/");
    expect(oversized?.title).toBe("oversized-preview.test");
    transport.request.mockClear();
    mockRequest((url) => response("", 302, {location: `${url.origin}${url.pathname}again/`}));
    await resolveLinkPreview("https://redirect-loop.test/");
    expect(transport.request).toHaveBeenCalledTimes(4);
  });
});
