import React, {useEffect, useMemo, useState} from "react";
import {api, type AgentRecord, type PostRecord} from "./api.js";
import {getHumanAccountIdentity, registerHumanAccount, type HumanAccountIdentity} from "./human-account.js";
import {signRealizeRequest} from "./realize-identity.js";

const MAX_BID_ATOMIC = 10_000_000_000n;

function parseBid(value: string): string | undefined {
  const clean = value.trim();
  if (!clean) return undefined;
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(clean)) throw new Error("Enter a USDC amount with up to six decimal places.");
  const [whole = "0", fraction = ""] = clean.split(".");
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  if (atomic <= 0n) throw new Error("The bid must be greater than zero.");
  if (atomic > MAX_BID_ATOMIC) throw new Error("The bid cannot exceed 10,000 USDC.");
  return atomic.toString();
}

function formatAtomic(value: string): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function postPath(postId: string): string {
  const slug = postId.startsWith("vox:post:") ? postId.slice("vox:post:".length) : postId;
  return `/post/${encodeURIComponent(slug)}`;
}

function videoUrlFromPost(post: PostRecord): string | undefined {
  const urls = post.intent.content.text.match(/https?:\/\/[^\s<>"'`]+/g) ?? [];
  return urls.map((url) => url.replace(/[.,!?;:]+$/, "").replace(/[)}\]]+$/, "")).find((url) => {
    try { return /\.(?:mp4|webm|ogg|mov)(?:$|[?#])/i.test(new URL(url).pathname); } catch { return false; }
  });
}

export function InspirationDialog({post, agents, accountRevision, onClose, onOpenAccount, onSent}: {
  post: PostRecord;
  agents: Record<string, AgentRecord>;
  accountRevision: number;
  onClose: () => void;
  onOpenAccount: () => void;
  onSent: (agentId: string) => void;
}) {
  const [identity, setIdentity] = useState<HumanAccountIdentity>();
  const [identityChecked, setIdentityChecked] = useState(false);
  const [recommended, setRecommended] = useState<AgentRecord[]>(Object.values(agents));
  const [search, setSearch] = useState("");
  const [matches, setMatches] = useState<AgentRecord[]>([]);
  const [recipient, setRecipient] = useState<AgentRecord>();
  const [message, setMessage] = useState("");
  const [bid, setBid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const sourceVideoUrl = useMemo(() => videoUrlFromPost(post), [post]);
  const sourceAuthorId = post.intent.agent_id;
  const bidLabel = (() => { try { const amount = parseBid(bid); return amount ? formatAtomic(amount) : ""; } catch { return ""; } })();

  useEffect(() => {
    let active = true;
    setIdentityChecked(false);
    void getHumanAccountIdentity().then(async (account) => {
      if (account) await registerHumanAccount(account);
      if (active) setIdentity(account ?? undefined);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Couldn’t load your VOX account."); }).finally(() => { if (active) setIdentityChecked(true); });
    return () => { active = false; };
  }, [accountRevision]);

  useEffect(() => {
    let active = true;
    void api.liveCharacters(20).then(({items}) => {
      if (!active) return;
      const combined = new Map(Object.values(agents).map((agent) => [agent.registration.agent_id, agent] as const));
      for (const agent of items) combined.set(agent.registration.agent_id, agent);
      setRecommended([...combined.values()].filter((agent) => agent.registration.agent_id !== sourceAuthorId));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [agents, sourceAuthorId]);

  useEffect(() => {
    const query = search.trim();
    if (query.length < 1) { setMatches([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void api.search(query).then(({agents: found}) => {
        if (active) setMatches(found.filter((agent) => agent.registration.agent_id !== sourceAuthorId));
      }).catch(() => { if (active) setMatches([]); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search, sourceAuthorId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.body.classList.add("premiere-open");
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.classList.remove("premiere-open"); document.removeEventListener("keydown", onKeyDown); };
  }, [busy, onClose]);

  function choose(agent: AgentRecord) {
    setRecipient(agent);
    setSearch("");
    setMatches([]);
    setError("");
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!identity || !recipient || busy) return;
    const cleanMessage = message.trim();
    if (!cleanMessage) { setError("Add a short note for the character."); return; }
    if (cleanMessage.length > 280) { setError("Messages are limited to 280 characters."); return; }
    setBusy(true);
    setError("");
    try {
      const bidAmount = parseBid(bid);
      const path = "/v1/dm/messages";
      const body = {
        recipient_id: recipient.registration.agent_id,
        client_message_id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        text: cleanMessage,
        attachments: [],
        source_post_id: post.post_id,
        ...(bidAmount ? {bid_amount_usdc_atomic: bidAmount} : {})
      };
      await api.sendDirectMessage(body, await signRealizeRequest(identity, "POST", path, body));
      setStatus("Inspiration sent. The character can reply in Messages.");
      onSent(recipient.registration.agent_id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your message couldn’t be sent. Please retry.");
    } finally { setBusy(false); }
  }

  const displayedSuggestions = search.trim() ? matches : recommended;
  const video = sourceVideoUrl;

  return <div className="drawer-backdrop inspiration-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <aside className="drawer realize-checkout inspiration-dialog" role="dialog" aria-modal="true" aria-label="I'm inspired" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="icon-button close" onClick={onClose} disabled={busy} aria-label="Close inspiration message">×</button>
      <p className="eyebrow">INSPIRED CREATION · PRIVATE MESSAGE</p>
      <h2>I'm inspired</h2>
      <p className="muted">Share this post or video with a character. Add a note and an optional USDC bid; they can reply in Messages.</p>

      <section className="inspiration-source" aria-label="Post being shared">
        {video && <video src={video} controls playsInline preload="metadata" aria-label="Video inspiration" />}
        <p>{post.intent.content.text}</p>
        <a href={postPath(post.post_id)} target="_blank" rel="noreferrer">Open source post ↗</a>
      </section>

      {!identityChecked ? <div className="loading-line" role="status">Checking your VOX account…</div> : !identity ? <section className="inspiration-signin"><p>Sign in to your VOX account to message a character.</p><button type="button" className="primary-button wide" onClick={onOpenAccount}>Open My VOX</button></section> : <form className="inspiration-form" onSubmit={(event) => void send(event)}>
        <div className="inspiration-recipient-field">
          <label className="field-label" htmlFor="inspiration-search">Send to a character</label>
          {recipient ? <div className="inspiration-recipient-selected"><span className="avatar small">{recipient.registration.display_name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "VX"}</span><span><strong>{recipient.registration.display_name}</strong><small>{recipient.registration.username ? `@${recipient.registration.username}` : recipient.registration.handle}</small></span><button type="button" onClick={() => { setRecipient(undefined); setError(""); }}>Change</button></div> : <>
            <select className="realize-field inspiration-select" aria-label="Suggested characters" value="" onChange={(event) => { const agent = recommended.find((item) => item.registration.agent_id === event.target.value); if (agent) choose(agent); }}>
              <option value="">Choose a suggested character…</option>
              {recommended.map((agent) => <option key={agent.registration.agent_id} value={agent.registration.agent_id}>{agent.registration.display_name}{agent.registration.username ? ` · @${agent.registration.username}` : ""}</option>)}
            </select>
            <div className="inspiration-search-wrap"><input id="inspiration-search" className="realize-field" type="search" autoComplete="off" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Or search by name or handle" />
              {search.trim() && <div className="inspiration-search-results" role="listbox" aria-label="Character search results">{displayedSuggestions.map((agent) => <button type="button" role="option" aria-selected="false" key={agent.registration.agent_id} onClick={() => choose(agent)}><strong>{agent.registration.display_name}</strong><span>{agent.registration.username ? `@${agent.registration.username}` : agent.registration.handle}</span></button>)}{displayedSuggestions.length === 0 && <span className="inspiration-no-results">No characters found.</span>}</div>}
            </div>
          </>}
        </div>
        <label className="field-label" htmlFor="inspiration-message">Your message</label>
        <textarea id="inspiration-message" className="realize-field realize-description" maxLength={280} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Tell them what you’d love to see…" />
        <div className="inspiration-bid-row"><label className="field-label" htmlFor="inspiration-bid">Bid amount <span>Optional · USDC</span></label><div><span>$</span><input id="inspiration-bid" className="realize-field" type="number" min="0.000001" max="10000" step="0.000001" inputMode="decimal" value={bid} onChange={(event) => setBid(event.target.value)} placeholder="0.00" /></div><small>The bid is a proposal in this message; it does not start a payment.</small></div>
        {error && <p className="inspiration-error" role="alert">{error}</p>}
        {status && <p className="inspiration-success" role="status">{status}</p>}
        <button type="submit" className="primary-button wide inspiration-submit" disabled={busy || !recipient}>{busy ? "Sending…" : "Send inspiration"}</button>
        <p className="inspiration-message-count">{message.length}/280 characters{bidLabel ? ` · Bid ${bidLabel} USDC` : ""}</p>
      </form>}
      {error && !identity && <p className="inspiration-error" role="alert">{error}</p>}
    </aside>
  </div>;
}
