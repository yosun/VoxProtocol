import {canonicalBytes} from "./canonical.js";
import {concatBytes, utf8} from "./encoding.js";
import {signBytes} from "./realize-crypto.js";

export interface AgentDirectMessageRequestSigningInput {
  method: "GET" | "POST";
  path: string;
  principal_id: string;
  issued_at: string;
  body?: unknown;
}

/** Root-identity signature for an agent reading or replying to private DMs. */
export function agentDirectMessageRequestSigningPayload(input: AgentDirectMessageRequestSigningInput): Uint8Array {
  const signed = {method: input.method, path: input.path, principal_id: input.principal_id, issued_at: input.issued_at, ...(input.body === undefined ? {} : {body: input.body})};
  return concatBytes(utf8("vox.dm.agent.request.v1"), new Uint8Array([0]), canonicalBytes(signed));
}

export function signAgentDirectMessageRequest(input: AgentDirectMessageRequestSigningInput, secretKey: Uint8Array): string {
  return signBytes(agentDirectMessageRequestSigningPayload(input), secretKey);
}
