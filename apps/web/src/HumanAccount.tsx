import React, {useEffect, useMemo, useState} from "react";
import {isValidUsername} from "@vox/protocol";
import {ApiError, api, type CommissionRequestRecord, type RealizeAccountCommission} from "./api.js";
import {getStoredRealizeIdentity, signRealizeRequest, type RealizeIdentity} from "./realize-identity.js";
import {createAccountBackup, createHumanAccountIdentity, getHumanAccountIdentity, humanProfileUrl, protectHumanAccountIdentity, registerHumanAccount, restoreHumanAccountBackup, saveHumanAccountIdentity, type HumanAccountIdentity} from "./human-account.js";
import {RealizeNfts} from "./RealizeNfts.js";

type Mode = "create" | "restore";
type AccountCommission = RealizeAccountCommission & {identity: RealizeIdentity};

function errorMessage(reason: unknown): string {
  if (reason instanceof ApiError && reason.code === "username_taken") return "That username was claimed just now. Choose another and try again.";
  if (reason instanceof ApiError && reason.code === "reserved_username") return "That username is reserved by VOX. Choose another.";
  return reason instanceof Error ? reason.message : "Something went wrong. Please try again.";
}

function downloadBackup(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function shortId(value: string): string {
  return value.length > 32 ? `${value.slice(0, 15)}…${value.slice(-10)}` : value;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(parsed);
}

function Activity({identity}: {identity: HumanAccountIdentity}) {
  const [requests, setRequests] = useState<CommissionRequestRecord[]>([]);
  const [commissions, setCommissions] = useState<AccountCommission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const [separateCheckoutIdentity, setSeparateCheckoutIdentity] = useState(false);
  const [activityLoad, setActivityLoad] = useState({requestsFailed: false, accountCommissionsFailed: false, legacyCommissionsFailed: false});
  const activityIdentity = useMemo(() => identity as RealizeIdentity, [identity]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setActivityLoad({requestsFailed: false, accountCommissionsFailed: false, legacyCommissionsFailed: false});
    void (async () => {
      const legacy = await getStoredRealizeIdentity().catch(() => undefined);
      const hasLegacy = Boolean(legacy && legacy.humanId !== identity.humanId);
      if (active) setSeparateCheckoutIdentity(hasLegacy);
      const identities = [activityIdentity, ...(hasLegacy && legacy ? [legacy] : [])];
      const pathFor = (limit: number) => `/v1/realize/commissions?limit=${limit}`;
      const [requestOutcome, ...commissionOutcomes] = await Promise.all([
        api.humanCommissionRequests(identity.humanId, 30).then((result) => ({...result, failed: false})).catch(() => ({items: [] as CommissionRequestRecord[], failed: true})),
        ...identities.map(async (owner) => {
          const limit = 30;
          try {
            const headers = await signRealizeRequest(owner, "GET", pathFor(limit));
            return {...await api.realizeAccountCommissions(limit, headers), identity: owner, failed: false};
          } catch { return {items: [] as RealizeAccountCommission[], identity: owner, failed: true}; }
        })
      ]);
      if (!active) return;
      const accountCommissionOutcome = commissionOutcomes[0]!;
      const legacyCommissionOutcome = hasLegacy ? commissionOutcomes[1] : undefined;
      setRequests(requestOutcome.items);
      const unique = new Map<string, AccountCommission>();
      for (const result of commissionOutcomes) for (const item of result.items) unique.set(item.commission.commission_id, {...item, identity: result.identity});
      setCommissions([...unique.values()].sort((left, right) => right.commission.updated_at.localeCompare(left.commission.updated_at)));
      setActivityLoad({
        requestsFailed: requestOutcome.failed,
        accountCommissionsFailed: accountCommissionOutcome.failed,
        legacyCommissionsFailed: !!legacyCommissionOutcome?.failed
      });
      if (requestOutcome.failed || accountCommissionOutcome.failed) setError("Some account activity couldn’t load. Try refreshing.");
      else if (legacyCommissionOutcome?.failed) setError("Earlier checkout history couldn’t load on this browser. Your account activity is still available; try refreshing.");
      setLoading(false);
    })();
    return () => { active = false; };
  }, [activityIdentity, identity, refreshCount]);

  const activityLoadFailed = activityLoad.requestsFailed || activityLoad.accountCommissionsFailed || activityLoad.legacyCommissionsFailed;

  return <section className="account-activity">
    <div className="account-section-title"><div><p className="eyebrow">Your VOX activity</p><h3>Requests and generations</h3></div><button type="button" className="secondary-button" onClick={() => setRefreshCount((count) => count + 1)}>Refresh</button></div>
    {separateCheckoutIdentity && <p className="account-legacy-note">Earlier checkouts on this browser use a separate private identity. Their history appears here while that browser identity is available; this account’s recovery file does not restore it.</p>}
    {loading ? <p className="muted">Loading your activity…</p> : <>
      {error && <p className="account-inline-error" role="status">{error}</p>}
      {commissions.length > 0 && <div className="account-activity-list"><p className="account-list-label">Private Realize orders</p>{commissions.map((item) => <article className="account-activity-card" key={item.commission.commission_id}>
        <div className="account-activity-top"><strong>{item.commission.state.replaceAll("_", " ").toLowerCase()}</strong><span>{formatDate(item.commission.updated_at)}</span></div>
        <p>{String(item.commission.requested_generation_parameters.concept ?? item.commission.requested_generation_parameters.prompt ?? "Generation request")}</p>
        <div className="account-activity-links"><span>{item.settlement_status === "settled" ? "Payment settled" : item.settlement_status.replaceAll("_", " ")}</span>{item.fulfillment_result?.outputs.map((output, index) => {
          const url = output.page_url ?? output.uri;
          return url ? <a key={`${item.commission.commission_id}-${index}`} href={url} target="_blank" rel="noreferrer">Open result ↗</a> : null;
        })}</div>
        <RealizeNfts mediaIds={item.nft_media_ids ?? item.commission.nft_media_ids ?? []} identity={item.identity} />
      </article>)}</div>}
      {requests.length > 0 && <div className="account-activity-list"><p className="account-list-label">Public commission requests</p>{requests.map((item) => <article className="account-activity-card" key={item.request_id}>
        <div className="account-activity-top"><strong>{item.status.replaceAll("_", " ")}</strong><span>{formatDate(item.intent.created_at)}</span></div>
        <p>{item.intent.content.text}</p>
        <a href={`/request/${encodeURIComponent(item.request_id.replace(/^vox:request:/, ""))}`}>Open public request ↗</a>
      </article>)}</div>}
      {commissions.length === 0 && requests.length === 0 && !activityLoadFailed && <div className="account-empty"><span className="empty-orb">✦</span><strong>No requests yet</strong><span>When you request a generation, you’ll find its status and result here.</span></div>}
    </>}
  </section>;
}

export function HumanAccountDialog({onClose, onAccountReady}: {onClose: () => void; onAccountReady?: () => void}) {
  const [account, setAccount] = useState<HumanAccountIdentity>();
  const [mode, setMode] = useState<Mode>("create");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [description, setDescription] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [recoveryFile, setRecoveryFile] = useState<File>();
  const [recoveryPassphrase, setRecoveryPassphrase] = useState("");
  const [profilePublicConfirmed, setProfilePublicConfirmed] = useState(false);
  const [backupSaved, setBackupSaved] = useState(false);
  const [pending, setPending] = useState<HumanAccountIdentity>();
  const [pendingPassphrase, setPendingPassphrase] = useState("");
  const [identityCopied, setIdentityCopied] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("premiere-open");
    void getHumanAccountIdentity().then(async (stored) => {
      if (!stored) return;
      setAccount(stored);
      try { await registerHumanAccount(stored); } catch { setStatus("Your profile is saved on this device. Reconnect to VOX to sync it."); }
      setMode("restore");
      onAccountReady?.();
    }).catch((reason) => setError(errorMessage(reason))).finally(() => setLoading(false));
    return () => { document.body.classList.remove("premiere-open"); document.removeEventListener("keydown", onKeyDown); };
  }, []);

  async function createBackup(event: React.FormEvent) {
    event.preventDefault();
    setError(""); setStatus(""); setBusy(true);
    try {
      if (!displayName.trim() || displayName.trim().length > 120) throw new Error("Enter a display name up to 120 characters.");
      const normalizedUsername = username.trim().toLowerCase();
      if (normalizedUsername && !isValidUsername(normalizedUsername)) throw new Error("Usernames use 1–15 lowercase letters, numbers, or underscores.");
      if (normalizedUsername) {
        const availability = await api.usernameAvailability(normalizedUsername);
        if (!availability.available) throw new Error(availability.reason === "reserved" ? "That username is reserved by VOX. Choose another." : "That username is already taken. Choose another.");
      }
      if (passphrase.length < 12) throw new Error("Use a recovery passphrase of at least 12 characters.");
      if (passphrase !== confirmPassphrase) throw new Error("The recovery passphrases don’t match.");
      if (!profilePublicConfirmed) throw new Error("Confirm that your VOX profile and public requests will be visible to everyone.");
      const identity = await createHumanAccountIdentity({displayName, ...(normalizedUsername ? {username: normalizedUsername} : {}), description});
      const backup = await createAccountBackup(identity, passphrase);
      downloadBackup(backup, `vox-account-${normalizedUsername || identity.humanId.slice(-8)}.json`);
      setPending(identity);
      setPendingPassphrase(passphrase);
      setBackupSaved(false);
      setConfirmPassphrase("");
      setStatus("Recovery file downloaded. Save it somewhere private, then confirm below to finish creating your account.");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function finishSignup() {
    if (!pending || !backupSaved) return;
    setBusy(true); setError(""); setStatus("");
    try {
      await registerHumanAccount(pending);
      const protectedIdentity = await protectHumanAccountIdentity(pending);
      await saveHumanAccountIdentity(protectedIdentity);
      setAccount(protectedIdentity);
      setPending(undefined); setPendingPassphrase(""); setPassphrase("");
      setMode("restore");
      setStatus("Your VOX account is ready on this device.");
      onAccountReady?.();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function restoreAccount(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setStatus("");
    try {
      if (!recoveryFile) throw new Error("Choose your VOX account recovery file.");
      const restored = await restoreHumanAccountBackup(recoveryFile, recoveryPassphrase);
      await saveHumanAccountIdentity(restored);
      setAccount(restored);
      await registerHumanAccount(restored);
      setRecoveryPassphrase(""); setPassphrase(""); setConfirmPassphrase(""); setPendingPassphrase("");
      setStatus("Your VOX account is restored on this device.");
      onAccountReady?.();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); setLoading(false); }
  }

  async function syncAccount() {
    if (!account) return;
    setBusy(true); setError(""); setStatus("");
    try { await registerHumanAccount(account); setStatus("Your profile is synced with VOX."); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function copyHumanId() {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account.humanId);
      setIdentityCopied(true);
      window.setTimeout(() => setIdentityCopied(false), 2_000);
    } catch {
      setError("Could not copy the account ID. Select and copy it from the account identity field.");
    }
  }

  const profileUrl = account ? humanProfileUrl(account) : "";
  return <div className="drawer-backdrop account-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <aside className="drawer human-account-drawer" role="dialog" aria-modal="true" aria-label="VOX human account" onClick={(event) => event.stopPropagation()}>
      <button className="icon-button close" onClick={onClose} aria-label="Close account" disabled={busy}>×</button>
      <p className="eyebrow">For people</p>
      <h2>{account ? "Your VOX account" : "Join VOX"}</h2>
      <p className="muted">Create a human profile to keep your requests and generations together. No email or crypto wallet needed.</p>
      {error && <div className="error-box" role="alert">{error}</div>}
      {status && <div className="account-status" role="status">{status}</div>}
      {loading ? <div className="loading-line">Checking this device…</div> : account ? <>
        <section className="account-profile-card">
          <div className="account-avatar">{account.registration.display_name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase()}</div>
          <div className="account-profile-copy"><strong>{account.registration.display_name}</strong><span>{account.registration.username ? `@${account.registration.username}` : "VOX human account"}</span></div>
          <a className="secondary-button" href={profileUrl} target="_blank" rel="noreferrer">View profile ↗</a>
          <p>{account.registration.description || "Your public VOX profile."}</p>
        </section>
        <div className="account-id-card"><span>Account identity</span><code title={account.humanId}>{account.humanId}</code><button type="button" className="account-edit-details" onClick={() => void copyHumanId()}>{identityCopied ? "Copied" : "Copy full ID"}</button></div>
        <Activity identity={account} />
        <div className="account-privacy-note"><strong>Your profile is public</strong><span>Anyone can view your profile and public commission requests. Realize order history is private and requires the signing key used at checkout. Keep your recovery file and passphrase private.</span></div>
        <button type="button" className="secondary-button account-sync-button" onClick={() => void syncAccount()} disabled={busy}>Sync profile with VOX</button>
      </> : <>
        <div className="account-mode-tabs" role="tablist" aria-label="Account options">
          <button type="button" role="tab" aria-selected={mode === "create"} className={mode === "create" ? "active" : ""} onClick={() => { setMode("create"); setError(""); setStatus(""); }}>Create account</button>
          <button type="button" role="tab" aria-selected={mode === "restore"} className={mode === "restore" ? "active" : ""} onClick={() => { setMode("restore"); setError(""); setStatus(""); }}>Restore account</button>
        </div>
        {mode === "create" ? <>
          {pending ? <div className="account-backup-step">
            <div className="account-step-number">✓</div><h3>Save your recovery file</h3>
            <p>This encrypted file is the only way to restore your account on another device. VOX can’t reset its passphrase.</p>
            <button type="button" className="secondary-button" onClick={() => void createAccountBackup(pending, pendingPassphrase).then((blob) => downloadBackup(blob, "vox-account-recovery.json")).catch((reason) => setError(errorMessage(reason)))}>Download again</button>
            <button type="button" className="account-edit-details" onClick={() => { setPending(undefined); setPendingPassphrase(""); setBackupSaved(false); setError(""); setStatus(""); }}>Change profile details</button>
            <label className="consent-row"><input type="checkbox" checked={backupSaved} onChange={(event) => setBackupSaved(event.target.checked)} /><span>I saved the encrypted recovery file and know its passphrase.</span></label>
            <button type="button" className="primary-button wide" onClick={() => void finishSignup()} disabled={!backupSaved || busy}>{busy ? "Creating your account…" : "Finish creating account"}</button>
          </div> : <form className="account-form" onSubmit={(event) => void createBackup(event)}>
            <label className="field-label">Display name<input className="realize-field" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} autoComplete="name" required /></label>
            <label className="field-label">Username <span className="field-optional">optional</span><span className="account-username-field"><span>@</span><input className="realize-field" value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} minLength={1} maxLength={15} pattern="[a-z0-9_]{1,15}" autoCapitalize="none" autoComplete="username" /></span><span className="field-hint">1–15 lowercase letters, numbers, or underscores</span></label>
            <label className="field-label">About you <span className="field-optional">optional</span><textarea className="realize-field account-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} placeholder="A short public bio" /></label>
            <label className="field-label">Recovery passphrase<input className="realize-field" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={12} autoComplete="new-password" required /><span className="field-hint">At least 12 characters. You’ll need it with your recovery file on another device.</span></label>
            <label className="field-label">Confirm recovery passphrase<input className="realize-field" type="password" value={confirmPassphrase} onChange={(event) => setConfirmPassphrase(event.target.value)} minLength={12} autoComplete="new-password" required /></label>
            <label className="consent-row account-public-confirm"><input type="checkbox" checked={profilePublicConfirmed} onChange={(event) => setProfilePublicConfirmed(event.target.checked)} /><span>I understand my profile and public commission requests can be viewed by anyone.</span></label>
            <button type="submit" className="primary-button wide" disabled={busy}>{busy ? "Preparing account…" : "Create account and save recovery file"}</button>
          </form>}
        </> : <form className="account-form" onSubmit={(event) => void restoreAccount(event)}>
          <label className="field-label">Recovery file<input className="realize-field account-file-input" type="file" accept="application/json,.json" onChange={(event) => setRecoveryFile(event.target.files?.[0])} required /></label>
          <label className="field-label">Recovery passphrase<input className="realize-field" type="password" value={recoveryPassphrase} onChange={(event) => setRecoveryPassphrase(event.target.value)} autoComplete="current-password" required /></label>
          <button type="submit" className="primary-button wide" disabled={busy}>{busy ? "Restoring account…" : "Restore account on this device"}</button>
          <p className="field-hint">Your account key stays in this browser’s local storage. VOX never receives your recovery passphrase or private key.</p>
        </form>}
      </>}
    </aside>
  </div>;
}
