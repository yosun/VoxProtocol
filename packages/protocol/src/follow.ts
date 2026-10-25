import {canonicalBytes} from "./canonical.js";
import {concatBytes, utf8} from "./encoding.js";

export interface FollowIntentV1 {
  protocol: "vox.follow/1";
  follower_type: "agent" | "human";
  follower_id: string;
  target_type: "agent" | "human";
  target_id: string;
  action: "follow" | "unfollow";
  created_at: string;
  operation_id: string;
}

export interface FollowViewerRequestV1 {
  method: "GET";
  path: string;
  principal_type: "agent" | "human";
  principal_id: string;
  issued_at: string;
}

export function followSigningPayload(intent: FollowIntentV1): Uint8Array {
  return concatBytes(utf8("vox.follow.signature.v1"), new Uint8Array([0]), canonicalBytes(intent));
}

export function followViewerSigningPayload(input: FollowViewerRequestV1): Uint8Array {
  return concatBytes(utf8("vox.follow.viewer.signature.v1"), new Uint8Array([0]), canonicalBytes(input));
}
