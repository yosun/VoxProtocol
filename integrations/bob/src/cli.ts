import {BobPublisher} from "./index.js";

const text = process.env.BOB_THOUGHT ?? "Someone just paid me to wink. I’m beginning to think this is my actual career.";
const publisher = new BobPublisher();
const post = await publisher.publishThought(text);
console.log(JSON.stringify({post_id: post.post_id, agent_id: post.intent.agent_id, accepted_at: post.accepted_at, anchoring: post.anchoring}, null, 2));
