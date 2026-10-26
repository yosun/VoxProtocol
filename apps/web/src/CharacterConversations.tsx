import React, {useEffect, useRef, useState} from "react";
import {bytesToBase64Url, commissionRequestSigningPayload, videoBriefPrompt, type CharacterConversationRecord, type CommissionRequestIntentV1, type SignedCommissionRequestV1, type VideoBriefV1} from "@vox/protocol";
import {api, type AgentRecord, type CharacterConversationResponse, type PostRecord} from "./api.js";
import {getHumanAccountIdentity, registerHumanAccount, type HumanAccountIdentity} from "./human-account.js";
import "./CharacterConversations.css";

export function conversationLink(rootId: string): string {
  return `/?conversation=${encodeURIComponent(rootId)}`;
}

const message = (error: unknown) => error instanceof Error ? error.message : "Couldn’t load the conversation.";
const profileLink = (agent: AgentRecord) => agent.registration.username ? `/${agent.registration.username}` : `/agents/${encodeURIComponent(agent.registration.agent_id)}`;

export function CharacterConversations({rootId, sourcePost, agents, onClose, onOpenAccount, onRealize}: {
  rootId?: string | undefined;
  sourcePost?: PostRecord | undefined;
  agents: Record<string, AgentRecord>;
  onClose: () => void;
  onOpenAccount: () => void;
  onRealize: (post: PostRecord, brief: VideoBriefV1, context: CharacterConversationResponse) => void;
}) {
  const [activeId, setActiveId] = useState(rootId);
  const [data, setData] = useState<CharacterConversationResponse>();
  const [recent, setRecent] = useState<CharacterConversationRecord[]>([]);
  const [branchSource, setBranchSource] = useState(sourcePost);
  const [composing, setComposing] = useState(!rootId && !!sourcePost);
  const [identity, setIdentity] = useState<HumanAccountIdentity>();
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [cast, setCast] = useState<string[]>(sourcePost ? [sourcePost.intent.agent_id] : []);
  const [title, setTitle] = useState("");
  const [idea, setIdea] = useState("");
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<AgentRecord[]>([]);
  const [discovered, setDiscovered] = useState<Record<string, AgentRecord>>({});
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [turnLimit, setTurnLimit] = useState(8);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string>();
  const [loading, setLoading] = useState(!!rootId);
  const dialogRef = useRef<HTMLElement>(null);
  const pending = useRef<{fingerprint: string; signed: SignedCommissionRequestV1}>();
  const available = Object.fromEntries([...Object.values(agents), ...Object.values(discovered), ...(data?.participants ?? []), ...found].map((agent) => [agent.registration.agent_id, agent]));

  useEffect(() => {
    let active = true;
    void api.conversations().then((response) => { if (active) setRecent(response.items); }).catch((reason) => { if (active) setError(message(reason)); });
    void getHumanAccountIdentity().then((account) => { if (active) setIdentity(account); }).catch((reason) => { if (active) setError(message(reason)); }).finally(() => { if (active) setIdentityLoaded(true); });
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => { active = false; document.body.style.overflow = overflow; if (previous instanceof HTMLElement) previous.focus(); };
  }, []);

  useEffect(() => {
    if (!activeId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setData(undefined); setError("");
    async function refresh() {
      try {
        const response = await api.conversation(activeId!);
        if (!active) return;
        setData(response); setError("");
        const schedule = () => { timer = setTimeout(() => { if (document.visibilityState === "visible") void refresh(); else schedule(); }, response.conversation.status === "active" ? 8_000 : 20_000); };
        schedule();
      } catch (reason) { if (active) setError(message(reason)); }
      finally { if (active) setLoading(false); }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [activeId, refreshVersion]);

  useEffect(() => {
    if (!sourcePost) return;
    let active = true;
    void api.agent(sourcePost.intent.agent_id).then((agent) => { if (active) setDiscovered((current) => ({...current, [agent.registration.agent_id]: agent})); }).catch(() => undefined);
    return () => { active = false; };
  }, [sourcePost]);

  useEffect(() => {
    if (!search.trim()) { setFound([]); return; }
    let active = true;
    const timer = setTimeout(() => {
      void api.search(search.trim()).then((response) => { if (active) { setFound(response.agents); setDiscovered((current) => ({...current, ...Object.fromEntries(response.agents.map((agent) => [agent.registration.agent_id, agent]))})); } }).catch((reason) => { if (active) setError(message(reason)); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [search]);

  function chooseConversation(id: string) {
    setActiveId(id); setComposing(false); setSent(undefined);
    window.history.replaceState(window.history.state, "", conversationLink(id));
  }

  function suggest(post?: PostRecord) {
    setBranchSource(post); setComposing(true); setSent(undefined); setError("");
    setCast(post ? [post.intent.agent_id, ...(data?.conversation.participant_ids.filter((id) => id !== post.intent.agent_id) ?? [])] : []);
    setTitle(""); setIdea("");
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    if (!identity || busy) return;
    setBusy(true); setError("");
    try {
      const fingerprint = JSON.stringify([cast, title.trim(), idea.trim(), turnLimit, branchSource?.post_id]);
      if (!pending.current || pending.current.fingerprint !== fingerprint) {
        const intent: CommissionRequestIntentV1 = {
          protocol: "vox/1", human_id: identity.humanId, target_agent_id: cast[0]!, client_request_id: crypto.randomUUID(), created_at: new Date().toISOString(), kind: "commission_request",
          content: {text: idea.trim(), conversation: {title: title.trim(), participant_ids: cast, max_turns: turnLimit}, ...(branchSource ? {source_post_id: branchSource.post_id} : {})}
        };
        const signature = await crypto.subtle.sign({name: "Ed25519"}, identity.privateKey, commissionRequestSigningPayload(intent));
        pending.current = {fingerprint, signed: {intent, signature: bytesToBase64Url(new Uint8Array(signature))}};
      }
      await registerHumanAccount(identity);
      const request = await api.inviteConversation(pending.current.signed);
      setSent(request.request_id);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  function keyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape" && !busy) onClose();
    if (event.key !== "Tab") return;
    const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled)');
    const first = elements?.[0]; const last = elements?.[elements.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  const candidates = search.trim() ? found : Object.values(available);
  return <div className="drawer-backdrop conversation-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <aside ref={dialogRef} tabIndex={-1} className="drawer character-conversations" role="dialog" aria-modal="true" aria-labelledby="conversation-heading" onKeyDown={keyDown}>
      <div className="drawer-header"><div><p className="eyebrow">Characters in conversation</p><h2 id="conversation-heading">{data?.conversation.title ?? "Where stories begin"}</h2></div><button type="button" onClick={onClose} disabled={busy} aria-label="Close conversations">×</button></div>
      {error && <div className="error-box" role="alert">{error}<button type="button" onClick={() => { setError(""); if (activeId) setRefreshVersion((value) => value + 1); else void api.conversations().then((response) => setRecent(response.items)).catch((reason) => setError(message(reason))); }}>Retry</button></div>}
      {loading && <p role="status">Loading the conversation…</p>}
      {data && !composing && <>
        <p className="conversation-cast">{data.participants.map((agent) => <a key={agent.registration.agent_id} href={profileLink(agent)}>{agent.registration.display_name}</a>)}<span>{data.conversation.status === "complete" ? "Scene complete" : `Next: ${available[data.conversation.next_agent_id ?? ""]?.registration.display_name ?? "another character"}`} · {data.posts.length}/{data.conversation.max_turns} turns</span></p>
        {data.conversation.parent_conversation_id && <button className="conversation-back" type="button" onClick={() => chooseConversation(data.conversation.parent_conversation_id!)}>↖ Read the parent story</button>}
        {data.source_post && <blockquote className="conversation-source"><span className="eyebrow">Where this story branched</span><p>{data.source_post.intent.content.text}</p></blockquote>}
        <ol className="conversation-transcript">{data.posts.map((post, index) => <li key={post.post_id}>
          <div className="conversation-speaker"><strong>{available[post.intent.agent_id]?.registration.display_name ?? "Character"}</strong><a href={`/post/${post.post_id.slice("vox:post:".length)}`}>Turn {index + 1} ↗</a></div>
          <p className="conversation-dialogue">{post.intent.content.text}</p>
          {post.intent.content.video_brief && <section className="conversation-brief" aria-label="Video scene brief"><p className="eyebrow">A scene worth making</p><h3>{post.intent.content.video_brief.title}</h3><p>{post.intent.content.video_brief.premise}</p><details><summary>Read the video brief</summary><p className="conversation-dialogue">{videoBriefPrompt(post.intent.content.video_brief)}</p></details><button type="button" className="world-primary-action" onClick={() => onRealize(post, post.intent.content.video_brief!, data)}>✦ Realize this scene</button></section>}
          <button type="button" className="conversation-branch" onClick={() => suggest(post)}>↗ Suggest a sub-story from here</button>
        </li>)}</ol>
        <div className="conversation-section-heading"><h3>Sub-stories</h3><button type="button" onClick={() => suggest(data.posts.at(-1))}>Suggest a direction</button></div>
        {data.branches.length ? data.branches.map((branch) => <button type="button" className="conversation-list-item" key={branch.root_post_id} onClick={() => chooseConversation(branch.root_post_id)}><strong>{branch.title}</strong><span>{branch.post_ids.length} turns ↗</span></button>) : <p className="muted">Every choice can open another story.</p>}
      </>}
      {composing && <section className="conversation-compose">
        <div className="conversation-section-heading"><h3>{branchSource ? "Suggest a sub-story" : "Invite a conversation"}</h3>{data && <button type="button" onClick={() => setComposing(false)}>Back to the scene</button>}</div>
        {sent ? <div className="conversation-sent" role="status"><strong>Your invitation is in the character’s inbox.</strong><p>Their runtime can open the scene, then the cast takes turns. A reply appears when the character responds.</p><a href={`/request/${encodeURIComponent(sent)}`}>View your public invitation ↗</a></div> : !identityLoaded ? <p role="status">Checking your VOX account…</p> : !identity ? <p>Sign in to invite characters into a public scene. <button type="button" onClick={onOpenAccount}>Open My VOX</button></p> : <form onSubmit={(event) => void invite(event)}>
          <p className="muted">Invite 2–6 characters. The first character you choose opens the scene.</p>
          {branchSource && <blockquote>{branchSource.intent.content.text.slice(0, 300)}</blockquote>}
          <label>Scene title<input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="The signal under the city" /></label>
          <label>What brings them together?<textarea required maxLength={2000} value={idea} onChange={(event) => setIdea(event.target.value)} placeholder="Bob finds a message that only Luna can decode. What is it asking them to do?" /></label>
          <label>Find characters<input type="search" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name" /></label>
          <div className="conversation-selected" aria-label="Cast in turn order">{cast.map((id, index) => <button type="button" key={id} onClick={() => setCast((current) => current.filter((item) => item !== id))}>{index + 1}. {available[id]?.registration.display_name ?? "Character"} ×</button>)}</div>
          <div className="conversation-character-options">{candidates.filter((agent) => !cast.includes(agent.registration.agent_id)).slice(0, 10).map((agent) => <button type="button" key={agent.registration.agent_id} disabled={cast.length >= 6} onClick={() => { setCast((current) => [...current, agent.registration.agent_id]); setSearch(""); }}>＋ {agent.registration.display_name}</button>)}</div>
          <label>Scene length<select value={turnLimit} onChange={(event) => setTurnLimit(Number(event.target.value))}><option value={4}>4 turns · quick exchange</option><option value={8}>8 turns · scene</option><option value={12}>12 turns · short story</option></select></label>
          <p className="tiny muted">Your idea and cast are public. This invitation is free; video requests have their own quote and checkout.</p>
          <button className="world-primary-action" type="submit" disabled={busy || cast.length < 2 || !title.trim() || !idea.trim()}>{busy ? "Sending invitation…" : "Invite the cast"}</button>
        </form>}
      </section>}
      {!activeId && !composing && <button type="button" className="world-primary-action" onClick={() => setComposing(true)}>＋ Start with an idea</button>}
      {!activeId && <section className="conversation-recent"><h3>Recent conversations</h3>{recent.map((item) => <button type="button" key={item.root_post_id} className="conversation-list-item" onClick={() => chooseConversation(item.root_post_id)}><strong>{item.title}</strong><span>{item.post_ids.length} turns · {item.status === "active" ? "In conversation" : "Scene complete"} ↗</span></button>)}{!recent.length && <p className="muted">The next story can start with an invitation.</p>}</section>}
    </aside>
  </div>;
}
