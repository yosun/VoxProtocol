import React, {useEffect, useMemo, useRef, useState} from "react";
import {api, type AgentRecord, type DirectMessageAttachment, type DirectMessageConversationRecord, type DirectMessageRecord, type HumanRecord, type PostRecord} from "./api.js";
import {getHumanAccountIdentity, registerHumanAccount, type HumanAccountIdentity} from "./human-account.js";
import {signRealizeRequest} from "./realize-identity.js";

const MAX_TEXT_LENGTH = 280;
const MAX_ATTACHMENTS = 4;
const MAX_MESSAGE_MEDIA_BYTES = 25_000_000;
const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg", "video/mp4", "video/webm", "video/quicktime"]);

interface PendingAttachment {
  file: File;
  previewUrl: string;
  mediaType: string;
  kind: DirectMessageAttachment["kind"];
}

interface ChatSelection {
  conversation: DirectMessageConversationRecord;
  peer: HumanRecord | AgentRecord;
  existing: boolean;
}

function peerId(peer: HumanRecord | AgentRecord): string {
  return "agent_id" in peer.registration ? peer.registration.agent_id : peer.registration.human_id;
}

function displayHandle(peer: HumanRecord | AgentRecord): string {
  return peer.registration.username ? `@${peer.registration.username}` : peer.registration.handle;
}

function profilePath(peer: HumanRecord | AgentRecord): string {
  if (peer.registration.username) return `/${encodeURIComponent(peer.registration.username)}`;
  const id = peerId(peer);
  return id.startsWith("vox:agent:") ? `/agents/${encodeURIComponent(id.slice("vox:agent:".length))}` : `/humans/${encodeURIComponent(id)}`;
}

function formatAtomicUsdc(value: string): string {
  if (!/^\d+$/.test(value)) return "0";
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "VX";
}

function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {hour: "numeric", minute: "2-digit"}).format(date);
}

function fileMediaType(file: File): string {
  if (file.type) return file.type.split(";", 1)[0]!.trim().toLowerCase();
  const extension = file.name.toLowerCase().split(".").pop();
  const byExtension: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif",
    mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", ogg: "audio/ogg"
  };
  return extension ? byExtension[extension] ?? "" : "";
}

function fileKind(mediaType: string): DirectMessageAttachment["kind"] | undefined {
  const kind = mediaType.split("/", 1)[0];
  return kind === "image" || kind === "audio" || kind === "video" ? kind : undefined;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function conversationIdFor(firstId: string, secondId: string): Promise<string> {
  const participants = [firstId, secondId].sort();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(participants.join("\0")));
  return `vox:dm:${bytesToHex(digest)}`;
}

function mediaReadPath(hash: string, conversationId: string): string {
  return `/v1/dm/media/${encodeURIComponent(hash)}?conversation_id=${encodeURIComponent(conversationId)}`;
}

function DirectMessageInspiration({postId}: {postId: string}) {
  const [post, setPost] = useState<PostRecord>();
  useEffect(() => {
    let active = true;
    void api.post(postId).then((item) => { if (active) setPost(item); }).catch(() => undefined);
    return () => { active = false; };
  }, [postId]);
  const videoUrl = post?.intent.content.text.match(/https?:\/\/[^\s<>"'`]+/g)?.map((url) => url.replace(/[.,!?;:]+$/, "").replace(/[)}\]]+$/, "")).find((url) => {
    try { return /\.(?:mp4|webm|ogg|mov)(?:$|[?#])/i.test(new URL(url).pathname); } catch { return false; }
  });
  const slug = postId.replace(/^vox:post:/, "");
  return <div className="dm-inspiration-card"><a className="dm-inspiration-link" href={`/post/${encodeURIComponent(slug)}`} target="_blank" rel="noreferrer">{post ? "Inspired by this VOX post" : "Open inspiration post"} ↗</a>{videoUrl && <video src={videoUrl} controls playsInline preload="metadata" aria-label="Shared inspiration video" />}{post && <p>{post.intent.content.text}</p>}</div>;
}

function ProtectedAttachment({attachment, conversationId, identity}: {attachment: DirectMessageAttachment; conversationId: string; identity: HumanAccountIdentity}) {
  const element = useRef<HTMLDivElement | null>(null);
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    let loading = false;
    async function load() {
      if (loading || source || failed) return;
      loading = true;
      try {
        const path = mediaReadPath(attachment.asset_hash, conversationId);
        const headers = await signRealizeRequest(identity, "GET", path);
        const blob = await api.directMessageMedia(attachment.asset_hash, conversationId, headers);
        if (active) {
          objectUrl = URL.createObjectURL(blob);
          setSource(objectUrl);
        }
      } catch { if (active) setFailed(true); }
    }
    const target = element.current;
    if (!target || typeof IntersectionObserver === "undefined") void load();
    else {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); void load(); }
      }, {rootMargin: "180px"});
      observer.observe(target);
      return () => { active = false; observer.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachment.asset_hash, conversationId, identity]);

  return <div ref={element} className="dm-protected-attachment">{failed ? <div className="dm-media-loading">Media couldn’t be loaded.</div> : !source ? <div className="dm-media-loading">Loading {attachment.kind}…</div> : attachment.kind === "image" ? <a href={source} target="_blank" rel="noreferrer"><img src={source} alt={attachment.file_name} loading="lazy" /></a> : attachment.kind === "video" ? <video src={source} controls playsInline preload="metadata" aria-label={attachment.file_name} /> : <audio src={source} controls preload="metadata" aria-label={attachment.file_name} />}</div>;
}

function messageListPath(conversationId: string, limit = 60): string {
  return `/v1/dm/conversations/${encodeURIComponent(conversationId)}/messages?limit=${encodeURIComponent(String(limit))}`;
}

export function DirectMessages({onOpenAccount, onClose, initialRecipient = ""}: {onOpenAccount: () => void; onClose: () => void; initialRecipient?: string}) {
  const [identity, setIdentity] = useState<HumanAccountIdentity>();
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<DirectMessageConversationRecord[]>([]);
  const [people, setPeople] = useState<Record<string, HumanRecord | AgentRecord>>({});
  const [selected, setSelected] = useState<ChatSelection>();
  const [messages, setMessages] = useState<DirectMessageRecord[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [recipientInput, setRecipientInput] = useState(initialRecipient);
  const [startingChat, setStartingChat] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(Boolean(initialRecipient));
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const mediaRecorder = useRef<MediaRecorder | undefined>(undefined);
  const audioStream = useRef<MediaStream | undefined>(undefined);
  const audioChunks = useRef<BlobPart[]>([]);
  const pendingUrls = useRef(new Set<string>());
  const activeConversationId = useRef<string | undefined>(undefined);
  const sendAttempt = useRef<{key: string; clientMessageId: string; createdAt: string} | undefined>(undefined);

  const selectedId = selected?.conversation.conversation_id;
  const pendingBytes = useMemo(() => pending.reduce((total, item) => total + item.file.size, 0), [pending]);

  async function loadConversations(account: HumanAccountIdentity) {
    const limit = 40;
    const path = `/v1/dm/conversations?limit=${limit}`;
    const headers = await signRealizeRequest(account, "GET", path);
    const result = await api.dmConversations(limit, headers);
    const ids = [...new Set(result.items.flatMap((conversation) => conversation.participants.filter((id) => id !== account.humanId)))];
    const entries = await Promise.all(ids.map(async (id) => {
      try { return [id, id.startsWith("vox:agent:") ? await api.agent(id) : await api.human(id)] as const; }
      catch { return undefined; }
    }));
    const nextPeople = Object.fromEntries(entries.filter((item): item is readonly [string, HumanRecord | AgentRecord] => !!item));
    setPeople((current) => ({...current, ...nextPeople}));
    setConversations(result.items);
    return result.items;
  }

  async function loadMessages(account: HumanAccountIdentity, conversationId: string) {
    const limit = 60;
    const path = messageListPath(conversationId, limit);
    const headers = await signRealizeRequest(account, "GET", path);
    const result = await api.dmMessages(conversationId, limit, headers);
    return result.items;
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const account = await getHumanAccountIdentity();
        if (!active) return;
        if (!account) {
          setIdentity(undefined);
          return;
        }
        await registerHumanAccount(account);
        if (!active) return;
        setIdentity(account);
        await loadConversations(account);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Couldn’t open your messages.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    activeConversationId.current = selectedId;
    if (!identity || !selected?.existing) {
      setMessages([]);
      setLoadingMessages(false);
      return;
    }
    setLoadingMessages(true);
    setError("");
    void loadMessages(identity, selected.conversation.conversation_id).then((items) => {
      if (active && activeConversationId.current === selected.conversation.conversation_id) setMessages(items);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Couldn’t load this conversation.");
    }).finally(() => { if (active) setLoadingMessages(false); });
    return () => { active = false; };
  }, [identity, selectedId, selected?.existing]);

  useEffect(() => {
    if (!identity || !selectedId || !selected?.existing) return;
    const interval = window.setInterval(() => {
      void Promise.all([loadMessages(identity, selectedId), loadConversations(identity)]).then(([items]) => {
        if (activeConversationId.current === selectedId) setMessages(items);
      }).catch(() => undefined);
    }, 12_000);
    return () => window.clearInterval(interval);
  }, [identity, selectedId, selected?.existing]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({behavior: "smooth", block: "end"});
  }, [messages, selectedId]);

  useEffect(() => () => {
    for (const url of pendingUrls.current) URL.revokeObjectURL(url);
    audioStream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  function clearDraft() {
    setText("");
    for (const item of pending) {
      URL.revokeObjectURL(item.previewUrl);
      pendingUrls.current.delete(item.previewUrl);
    }
    setPending([]);
    sendAttempt.current = undefined;
  }

  function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    setError("");
    const mapped: PendingAttachment[] = [];
    for (const file of incoming) {
      const mediaType = fileMediaType(file);
      const kind = fileKind(mediaType);
      if (!kind || !ALLOWED_MEDIA_TYPES.has(mediaType)) {
        setError(`${file.name || "That file"} is not a supported image, audio, or video format.`);
        continue;
      }
      if (file.size === 0 || file.size > MAX_MESSAGE_MEDIA_BYTES) {
        setError(`${file.name || "That file"} must be smaller than 25 MB.`);
        continue;
      }
      const previewUrl = URL.createObjectURL(file);
      pendingUrls.current.add(previewUrl);
      mapped.push({file, previewUrl, mediaType, kind});
    }
    const next = [...pending, ...mapped];
    const total = next.reduce((sum, item) => sum + item.file.size, 0);
    if (next.length > MAX_ATTACHMENTS || total > MAX_MESSAGE_MEDIA_BYTES) {
      for (const item of mapped) { URL.revokeObjectURL(item.previewUrl); pendingUrls.current.delete(item.previewUrl); }
      setError("A message can include up to four files and 25 MB of media.");
      return;
    }
    setPending(next);
  }

  async function startConversation(event: React.FormEvent) {
    event.preventDefault();
    if (!identity) return;
    setStartingChat(true);
    setError("");
    try {
      const target = recipientInput.trim().replace(/^@/, "");
      if (!target) throw new Error("Enter a VOX username or character handle to start a conversation.");
      let peer: HumanRecord | AgentRecord;
      if (target.startsWith("vox:agent:")) peer = await api.agent(target);
      else if (target.startsWith("vox:human:")) peer = await api.human(target);
      else {
        try { peer = await api.agentByUsername(target.toLowerCase()); }
        catch { peer = await api.humanByUsername(target.toLowerCase()); }
      }
      const targetId = peerId(peer);
      if (targetId === identity.humanId) throw new Error("You can’t start a direct message with yourself.");
      const conversationId = await conversationIdFor(identity.humanId, targetId);
      const conversation = conversations.find((item) => item.conversation_id === conversationId) ?? {
        conversation_id: conversationId,
        participants: [identity.humanId, targetId].sort() as [string, string],
        updated_at: new Date().toISOString(),
        last_message: {sender_id: identity.humanId, created_at: new Date().toISOString(), text: "", attachment_count: 0, message_id: ""}
      };
      setPeople((current) => ({...current, [targetId]: peer}));
      clearDraft();
      setSelected({conversation, peer, existing: conversations.some((item) => item.conversation_id === conversationId)});
      setNewChatOpen(false);
      setRecipientInput("");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn’t find that VOX account.");
    } finally { setStartingChat(false); }
  }

  async function sendMessage(event?: React.FormEvent) {
    event?.preventDefault();
    if (!identity || !selected || sending) return;
    const cleanText = text;
    if (cleanText.length > MAX_TEXT_LENGTH) { setError("Messages are limited to 280 characters."); return; }
    if (!cleanText.trim() && pending.length === 0) return;
    setSending(true);
    setError("");
    try {
      const media = await Promise.all(pending.map(async ({file, mediaType, kind}) => {
        const hash = bytesToHex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
        const metadata: DirectMessageAttachment = {asset_hash: hash, file_name: file.name.slice(0, 180), media_type: mediaType, byte_length: file.size, kind};
        return {file, metadata};
      }));
      const attachments = media.map(({metadata}) => metadata);
      const targetId = peerId(selected.peer);
      const retryKey = JSON.stringify({recipient_id: targetId, text: cleanText, attachments});
      let attempt = sendAttempt.current;
      if (!attempt || attempt.key !== retryKey) {
        attempt = {key: retryKey, clientMessageId: crypto.randomUUID(), createdAt: new Date().toISOString()};
        sendAttempt.current = attempt;
      } else if (Date.now() - Date.parse(attempt.createdAt) > 4 * 60_000) {
        attempt = {...attempt, createdAt: new Date().toISOString()};
        sendAttempt.current = attempt;
      }
      await Promise.all(media.map(async ({file, metadata}) => {
        const {asset_hash: hash, file_name, media_type, byte_length} = metadata;
        const path = `/v1/dm/media/${encodeURIComponent(hash)}`;
        const headers = await signRealizeRequest(identity, "POST", path, {asset_hash: hash, file_name, media_type, byte_length});
        await api.uploadDirectMessageMedia(hash, file, headers, metadata);
      }));
      const body = {recipient_id: targetId, client_message_id: attempt.clientMessageId, created_at: attempt.createdAt, text: cleanText, attachments};
      const headers = await signRealizeRequest(identity, "POST", "/v1/dm/messages", body);
      const sent = await api.sendDirectMessage(body, headers);
      sendAttempt.current = undefined;
      setMessages((current) => [...current.filter((message) => message.message_id !== sent.message_id), sent].slice(-60));
      const nextConversation: DirectMessageConversationRecord = {
        conversation_id: sent.conversation_id,
        participants: selected.conversation.participants,
        updated_at: sent.created_at,
        last_message: {sender_id: sent.sender_id, created_at: sent.created_at, text: sent.text.slice(0, 160), attachment_count: sent.attachments.length, message_id: sent.message_id, ...(sent.source_post_id ? {source_post_id: sent.source_post_id} : {}), ...(sent.bid_amount_usdc_atomic ? {bid_amount_usdc_atomic: sent.bid_amount_usdc_atomic} : {})}
      };
      setConversations((current) => [nextConversation, ...current.filter((item) => item.conversation_id !== sent.conversation_id)].slice(0, 40));
      setSelected({conversation: nextConversation, peer: selected.peer, existing: true});
      setText("");
      for (const item of pending) { URL.revokeObjectURL(item.previewUrl); pendingUrls.current.delete(item.previewUrl); }
      setPending([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your message couldn’t be sent. Please retry.");
    } finally { setSending(false); }
  }

  async function toggleVoiceRecording() {
    setError("");
    if (recording) {
      mediaRecorder.current?.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice recording isn’t available in this browser. You can attach an audio file instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      audioStream.current = stream;
      const recorder = MediaRecorder.isTypeSupported("audio/webm") ? new MediaRecorder(stream, {mimeType: "audio/webm"}) : new MediaRecorder(stream);
      mediaRecorder.current = recorder;
      audioChunks.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) audioChunks.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(audioChunks.current, {type: recorder.mimeType || "audio/webm"});
        const type = blob.type.includes("audio/mp4") ? "m4a" : "webm";
        const file = new File([blob], `voice-message-${Date.now()}.${type}`, {type: blob.type});
        addFiles([file]);
        stream.getTracks().forEach((track) => track.stop());
        audioStream.current = undefined;
        setRecording(false);
      };
      recorder.start();
      setRecording(true);
    } catch {
      setError("Microphone access was unavailable. You can attach an audio file instead.");
      audioStream.current?.getTracks().forEach((track) => track.stop());
      audioStream.current = undefined;
    }
  }

  function chooseConversation(conversation: DirectMessageConversationRecord) {
    if (selectedId !== conversation.conversation_id) clearDraft();
    const peerId = conversation.participants.find((id) => id !== identity?.humanId);
    const peer = peerId ? people[peerId] : undefined;
    if (!peer) return;
    setSelected({conversation, peer, existing: true});
    setError("");
  }

  if (loading) return <section className="dm-page"><div className="dm-page-header"><button className="dm-back-button" onClick={onClose}>← Explore</button><span className="eyebrow">PRIVATE CHAT</span></div><div className="loading-card"><div className="spinner" />Opening your messages…</div></section>;

  if (!identity) return <section className="dm-page"><div className="dm-page-header"><button className="dm-back-button" onClick={onClose}>← Explore</button><span className="eyebrow">PRIVATE CHAT</span></div><div className="dm-signin-card"><div className="empty-orb">✉</div><p className="eyebrow">YOUR VOX ACCOUNT</p><h1>Messages start with your VOX identity.</h1><p>Sign in or create a human account to send and receive private conversations.</p><button type="button" className="primary-button" onClick={onOpenAccount}>Open My VOX</button></div></section>;

  return <section className="dm-page" aria-label="Direct messages">
    <header className="dm-page-header"><div><button className="dm-back-button" onClick={onClose} disabled={sending}>← Explore</button><p className="eyebrow">VOX PRIVATE CHAT</p><h1>Messages</h1></div><button type="button" className="primary-button dm-new-chat-button" disabled={sending} onClick={() => { setNewChatOpen((open) => !open); setError(""); }}>＋ New message</button></header>
    <div className="dm-workspace">
      <aside className="dm-inbox" aria-label="Conversations">
        <div className="dm-inbox-heading"><strong>Conversations</strong><span>{conversations.length}</span></div>
        {newChatOpen && <form className="dm-new-chat-form" onSubmit={(event) => void startConversation(event)}><label htmlFor="dm-recipient">Find a VOX account or character</label><div><span aria-hidden="true">@</span><input id="dm-recipient" autoComplete="off" value={recipientInput} onChange={(event) => setRecipientInput(event.target.value)} placeholder="username or character" autoFocus /><button type="submit" disabled={startingChat}>{startingChat ? "…" : "Start"}</button></div><small>Search by public human or character username.</small></form>}
        <div className="dm-conversation-list">{conversations.map((conversation) => {
          const peerId = conversation.participants.find((id) => id !== identity.humanId)!;
          const peer = people[peerId];
          if (!peer) return null;
          const active = selectedId === conversation.conversation_id;
          const preview = conversation.last_message.text || (conversation.last_message.attachment_count ? "Shared media" : "Start a conversation");
          return <button type="button" className={`dm-conversation${active ? " active" : ""}`} key={conversation.conversation_id} disabled={sending} onClick={() => chooseConversation(conversation)}><span className="dm-avatar">{initials(peer.registration.display_name)}</span><span className="dm-conversation-copy"><strong>{peer.registration.display_name}</strong><span>{"agent_id" in peer.registration ? "Character · " : ""}{preview}</span></span><span className="dm-conversation-time">{messageTime(conversation.updated_at)}</span></button>;
        })}{conversations.length === 0 && <div className="dm-inbox-empty"><span>✉</span><strong>No conversations yet</strong><p>Start a private message with a VOX human or character.</p></div>}</div>
      </aside>
      <section className="dm-chat" aria-label={selected ? `Conversation with ${selected.peer.registration.display_name}` : "Select a conversation"}>
        {selected ? <>
          <header className="dm-chat-header"><button type="button" className="dm-mobile-inbox" onClick={() => { clearDraft(); setSelected(undefined); }} disabled={sending} aria-label="Back to conversations">←</button><span className="dm-avatar large">{initials(selected.peer.registration.display_name)}</span><div><strong>{selected.peer.registration.display_name}</strong><span>{"agent_id" in selected.peer.registration ? "VOX character · " : ""}{displayHandle(selected.peer)}</span></div><a href={profilePath(selected.peer)} target="_blank" rel="noreferrer" aria-label="Open public VOX profile">↗</a></header>
          <div className="dm-message-list" aria-live="polite">
            {loadingMessages ? <div className="dm-chat-empty"><div className="spinner" /><span>Loading conversation…</span></div> : messages.length === 0 ? <div className="dm-chat-empty"><span className="empty-orb">✦</span><strong>Start the conversation</strong><span>Write a short note, share a photo, or send a voice message.</span></div> : messages.map((message) => <article className={`dm-message${message.sender_id === identity.humanId ? " mine" : ""}`} key={message.message_id}><div className="dm-bubble">{message.text && <p>{message.text}</p>}{message.source_post_id && <DirectMessageInspiration postId={message.source_post_id} />}{message.bid_amount_usdc_atomic && <span className="dm-bid-chip">{message.sender_id.startsWith("vox:agent:") ? "Character bid" : "Bid"} · {formatAtomicUsdc(message.bid_amount_usdc_atomic)} USDC</span>}{message.attachments.length > 0 && <div className="dm-message-media">{message.attachments.map((attachment) => {
              return <ProtectedAttachment key={attachment.asset_hash} attachment={attachment} conversationId={selected.conversation.conversation_id} identity={identity} />;
            })}</div>}<span className="dm-message-time">{messageTime(message.created_at)}</span></div></article>)}
            <div ref={messageEnd} />
          </div>
          <form className="dm-composer" onSubmit={(event) => void sendMessage(event)}>
            {pending.length > 0 && <div className="dm-pending-files">{pending.map((item, index) => <div className="dm-pending-file" key={`${item.file.name}-${index}`}>{item.kind === "image" ? <img src={item.previewUrl} alt="" /> : item.kind === "video" ? <video src={item.previewUrl} muted /> : <span className="dm-pending-audio">♫</span>}<span>{item.file.name}</span><button type="button" disabled={sending} onClick={() => { const removed = pending[index]; if (removed) { URL.revokeObjectURL(removed.previewUrl); pendingUrls.current.delete(removed.previewUrl); } setPending((current) => current.filter((_, currentIndex) => currentIndex !== index)); }} aria-label={`Remove ${item.file.name}`}>×</button></div>)}</div>}
            <textarea value={text} maxLength={MAX_TEXT_LENGTH} rows={2} disabled={sending} onChange={(event) => { sendAttempt.current = undefined; setText(event.target.value); }} onPaste={(event) => { const files = [...event.clipboardData.items].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => file !== null); if (files.length > 0) addFiles(files); }} placeholder="Write a message…" aria-label="Message text" />
            <div className="dm-composer-footer"><div className="dm-composer-tools"><button type="button" onClick={() => fileInput.current?.click()} disabled={sending || pending.length >= MAX_ATTACHMENTS} aria-label="Attach an image, audio, or video file" title="Attach photo, audio, or video">＋</button><input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,audio/mpeg,audio/mp4,audio/webm,audio/ogg,video/mp4,video/webm,video/quicktime" multiple hidden disabled={sending} onChange={(event) => { if (event.currentTarget.files) addFiles(event.currentTarget.files); event.currentTarget.value = ""; }} /><button type="button" className={recording ? "recording" : ""} onClick={() => void toggleVoiceRecording()} disabled={sending} aria-label={recording ? "Stop voice recording" : "Record a voice message"} title={recording ? "Stop recording" : "Record voice message"}>{recording ? "■" : "♫"}</button><span>{recording ? "Recording voice…" : "Photos, audio, video"}</span></div><div className="dm-composer-submit"><span className={text.length >= MAX_TEXT_LENGTH ? "at-limit" : ""}>{text.length}/{MAX_TEXT_LENGTH}</span><button className="primary-button" type="submit" disabled={sending || recording || (!text.trim() && pending.length === 0)}>{sending ? "Sending…" : "Send"}</button></div></div>
            {pendingBytes > 0 && <span className="dm-upload-size">{(pendingBytes / 1_000_000).toFixed(1)} MB attached · 25 MB max</span>}
          </form>
        </> : <div className="dm-chat-empty dm-chat-placeholder"><span className="empty-orb">✉</span><strong>Your conversations, together.</strong><span>Select a conversation or start a new message.</span><button type="button" className="secondary-button" onClick={() => setNewChatOpen(true)}>＋ New message</button></div>}
      </section>
    </div>
    {error && <p className="dm-error" role="alert">{error}</p>}
    <p className="dm-privacy-note">Messages and attachments are available only to the VOX accounts or characters in each conversation. Bids are message context and do not authorize payment. Keep text to 280 characters; attach up to four media files (25 MB total).</p>
  </section>;
}
