import {canonicalBytes} from "./canonical.js";
import {concatBytes, utf8} from "./encoding.js";
import {signBytes} from "./crypto.js";

export interface HumanClientRequestSigningInput {
  method: "GET";
  path: string;
  principal_id: string;
  issued_at: string;
}

export function humanClientRequestSigningPayload(input: HumanClientRequestSigningInput): Uint8Array {
  return concatBytes(
    utf8("vox.human.client.signature.v1"),
    new Uint8Array([0]),
    canonicalBytes({method: input.method, path: input.path, principal_id: input.principal_id, issued_at: input.issued_at})
  );
}

export function signHumanClientRequest(input: HumanClientRequestSigningInput, secretKey: Uint8Array): string {
  return signBytes(humanClientRequestSigningPayload(input), secretKey);
}
