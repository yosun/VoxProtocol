import type {FetchFn} from "@solana/web3.js";
import {publicPageUrl} from "./api.js";
import {signRealizeRequest, type RealizeIdentity} from "./realize-identity.js";

/** The API binds each RPC request to the owner and accepted commission. */
export function checkoutRpcConnection(identity: RealizeIdentity, commissionId: string): {rpcUrl: string; rpcFetch: FetchFn} {
  const path = `/v1/realize/commissions/${encodeURIComponent(commissionId)}/solana-rpc`;
  const rpcUrl = publicPageUrl(path);
  const rpcFetch = (async (_url: unknown, init?: {body?: unknown}) => {
    if (typeof init?.body !== "string") throw new Error("Invalid checkout RPC request.");
    const body: unknown = JSON.parse(init.body);
    const headers = await signRealizeRequest(identity, "POST", path, body);
    return fetch(rpcUrl, {method: "POST", headers: {"content-type": "application/json", ...headers}, body: init.body, credentials: "omit", redirect: "error"});
  }) as FetchFn;
  return {rpcUrl, rpcFetch};
}
