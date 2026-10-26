import type {DirectMessageHistoryPosition} from "./types.js";
import {HttpError} from "./errors.js";

export function encodeDirectMessageCursor(conversationId: string, position: DirectMessageHistoryPosition): string {
  return Buffer.from(JSON.stringify({conversation_id: conversationId, created_at: position.created_at, message_id: position.message_id})).toString("base64url");
}

export function decodeDirectMessageCursor(value: string | undefined, conversationId: string): DirectMessageHistoryPosition | undefined {
  if (value === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error("invalid cursor bytes");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Object.keys(parsed).sort().join(",") !== "conversation_id,created_at,message_id" || parsed.conversation_id !== conversationId || typeof parsed.created_at !== "string" || !Number.isFinite(Date.parse(parsed.created_at)) || typeof parsed.message_id !== "string" || !/^vox:dm:message:[0-9a-f]{64}$/.test(parsed.message_id)) throw new Error("invalid cursor fields");
    return {created_at: parsed.created_at, message_id: parsed.message_id};
  } catch { throw new HttpError(400, "invalid_cursor", "message cursor is malformed or belongs to another conversation"); }
}
