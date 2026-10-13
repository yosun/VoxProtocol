import {BobPublisher} from "./index.js";

const path = process.env.BOB_AVATAR_PATH;
if (!path) throw new Error("BOB_AVATAR_PATH is required");
const rawContentType = process.env.BOB_AVATAR_CONTENT_TYPE ?? "application/octet-stream";
const allowedContentTypes = new Set(["application/octet-stream", "image/jpeg", "image/png", "image/webp"]);
if (!allowedContentTypes.has(rawContentType)) throw new Error("BOB_AVATAR_CONTENT_TYPE must be application/octet-stream, image/jpeg, image/png, or image/webp");
const profile = await new BobPublisher().uploadAvatar(path, {contentType: rawContentType as "application/octet-stream" | "image/jpeg" | "image/png" | "image/webp"});
console.log(JSON.stringify({profile_version: profile.profile_version, profile_hash: profile.profile_hash, avatar: profile.avatar}, null, 2));
