import React, {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {videoBriefPrompt, base64UrlToBytes, canonicalBytes, computeFirstPartyRealizeRightsPolicyHash, computeRevenueRightsAgreementHash, concatBytes, REALIZE_COMMISSIONER_ROLE_PARTY_ID, ProvenanceRecordV1Schema, RealizeQuoteV1Schema, verifyBytes, verifyRealizeQuoteSignature, utf8} from "@vox/protocol";
import {useConnectedWallet, useWalletStatus, useWallets} from "@solana/kit-plugin-wallet/react";
import {ApiError, api, type AgentRecord, type PostRecord, type RealizeCapabilities, type RealizeCommissionStatus, type RealizeFunding, type RealizeProvenance, type RealizeQuote, type RealizeRightsAgreement} from "./api.js";
import {getRealizeIdentity, signRealizeRequest, type RealizeIdentity} from "./realize-identity.js";
import {checkSolanaTransaction, recoverUsdcPayment, sendRealizeEscrowPayment, sendRealizeEscrowRefund, sendUsdcPayment, walletRejected, type UsdcPaymentAttempt} from "./solana-payment.js";
import {configuredWalletCluster, solanaWalletClient, walletChainForCluster} from "./solana-wallet.js";
import {RealizeNfts} from "./RealizeNfts.js";
import {generationDescription, videoOptions, type VideoOptions} from "./realize-parameters.js";
import {readFinancialCheckpoint, withFinancialLock, writeFinancialCheckpoint, type FinancialCheckpoint, type FinancialOutcome} from "./financial-checkpoints.js";

type RealizeStyle = "cinematic" | "portrait" | "documentary" | "ambient" | "special";
type PaymentProgress = "preparing" | "wallet_approval" | "solana_confirmation" | "vox_verification";
type SavedCheckout = {version: 2; originPostId: string; creatorId: string; description: string; style: RealizeStyle; duration: number; resolution?: string; testVideo?: boolean; idempotencyKey: string; requestId: string; commissionId?: string; transactionSignature?: string; paymentAttempt?: UsdcPaymentAttempt; financialAttemptId?: string; financialPredecessor?: string; refundTransactionSignature?: string; transactionUrl?: string; publicAttribution?: string; nftPublicationConsent?: boolean};
const CHECKOUT_KEY = "vox.realize.v1.checkout";
const CHECKPOINTS_KEY = "vox.realize.v1.checkpoints";
type CheckoutCheckpoints = {version: 1; latestByPost: Record<string, string>; entries: Record<string, SavedCheckout>};
const REALIZE_TEST_VIDEO_CAPABILITY_ID = "video:integration-test";
const REALIZE_TEST_VIDEO_PROVIDER_ID = "provider:video:integration-test";
const REALIZE_TEST_VIDEO_REQUEST = Object.freeze({concept: "Populi integration test video", style: "test", duration_seconds: 5, resolution: "480P"});
const STYLE_OPTIONS: Array<{value: RealizeStyle; label: string}> = [
  {value: "cinematic", label: "Cinematic"}, {value: "portrait", label: "Portrait"},
  {value: "documentary", label: "Documentary"}, {value: "ambient", label: "Ambient"}, {value: "special", label: "Special"}
];

function validSavedCheckout(value: unknown): value is SavedCheckout {
  if (!value || typeof value !== "object") return false;
  const saved = value as Partial<SavedCheckout>;
  return saved.version === 2 && typeof saved.originPostId === "string" && typeof saved.creatorId === "string" && typeof saved.description === "string" && STYLE_OPTIONS.some((item) => item.value === saved.style) && typeof saved.duration === "number" && (saved.testVideo === undefined || typeof saved.testVideo === "boolean") && typeof saved.idempotencyKey === "string" && typeof saved.requestId === "string";
}

function checkpointId(checkout: SavedCheckout): string {
  return checkout.commissionId ? `commission:${checkout.commissionId}` : `draft:${checkout.originPostId}`;
}

function loadCheckpoints(): CheckoutCheckpoints {
  const registry: CheckoutCheckpoints = {version: 1, latestByPost: {}, entries: {}};
  try {
    const raw = sessionStorage.getItem(CHECKPOINTS_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<CheckoutCheckpoints> : undefined;
    if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object" && parsed.latestByPost && typeof parsed.latestByPost === "object") {
      registry.entries = Object.fromEntries(Object.entries(parsed.entries).filter(([id, checkout]) => validSavedCheckout(checkout) && checkpointId(checkout) === id));
      registry.latestByPost = Object.fromEntries(Object.entries(parsed.latestByPost).filter(([postId, id]) => typeof id === "string" && registry.entries[id]?.originPostId === postId));
    }
  } catch { /* An older valid singleton can still be recovered below. */ }
  try {
    const raw = sessionStorage.getItem(CHECKOUT_KEY);
    const legacy: unknown = raw ? JSON.parse(raw) : undefined;
    if (validSavedCheckout(legacy)) {
      const id = checkpointId(legacy);
      if (!registry.entries[id]) registry.entries[id] = legacy;
      if (!registry.latestByPost[legacy.originPostId]) registry.latestByPost[legacy.originPostId] = id;
      sessionStorage.setItem(CHECKPOINTS_KEY, JSON.stringify(registry));
    }
  } catch { /* Recovery stays available in memory when storage is disabled. */ }
  return registry;
}

function loadSavedCheckout(originPostId: string, commissionId?: string): SavedCheckout | undefined {
  const registry = loadCheckpoints();
  const id = commissionId ? `commission:${commissionId}` : registry.latestByPost[originPostId];
  const checkout = id ? registry.entries[id] : undefined;
  return checkout?.originPostId === originPostId ? checkout : undefined;
}

function saveCheckout(value: SavedCheckout): void {
  try {
    const registry = loadCheckpoints();
    const id = checkpointId(value);
    registry.entries[id] = value;
    registry.latestByPost[value.originPostId] = id;
    if (value.commissionId) delete registry.entries[`draft:${value.originPostId}`];
    sessionStorage.setItem(CHECKPOINTS_KEY, JSON.stringify(registry));
    sessionStorage.setItem(CHECKOUT_KEY, JSON.stringify(value));
  } catch {
    /* Draft/status updates can continue when storage is unavailable. */
  }
}

function clearCheckout(originPostId: string): void {
  try {
    const registry = loadCheckpoints();
    const id = registry.latestByPost[originPostId];
    if (id && (registry.entries[id]?.transactionSignature || registry.entries[id]?.paymentAttempt || registry.entries[id]?.refundTransactionSignature)) return;
    if (id) delete registry.entries[id];
    delete registry.latestByPost[originPostId];
    sessionStorage.setItem(CHECKPOINTS_KEY, JSON.stringify(registry));
    const raw = sessionStorage.getItem(CHECKOUT_KEY);
    if (raw && (JSON.parse(raw) as Partial<SavedCheckout>).originPostId === originPostId) sessionStorage.removeItem(CHECKOUT_KEY);
  } catch { /* Ignore disabled storage. */ }
}

async function migrateFinancialCheckpoints(): Promise<void> {
  for (const saved of Object.values(loadCheckpoints().entries)) {
    if (!saved.commissionId || !saved.transactionSignature && !saved.paymentAttempt && !saved.refundTransactionSignature) continue;
    const attemptId = saved.financialAttemptId ?? crypto.randomUUID();
    await writeFinancialCheckpoint({sourcePostId: saved.originPostId, commissionId: saved.commissionId, attemptId, outcome: "pending", updatedAt: Date.now(), checkout: {...saved, financialAttemptId: attemptId}}, {migrateOnly: true});
  }
}

function money(value: string | undefined): string {
  if (value === undefined || !/^\d+$/.test(value)) return "—";
  const atomic = BigInt(value);
  const whole = (atomic / 1_000_000n).toString();
  const decimal = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${(decimal || "00").padEnd(2, "0")}`;
}

function short(value: string): string { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }

function commissionPath(id: string): string { return `/v1/realize/commissions/${encodeURIComponent(id)}`; }

function realizePromptFromSearch(search: string): string | undefined {
  const value = new URLSearchParams(search).get("prompt")?.trim();
  return value && value.length <= 280 ? value : undefined;
}

function rightsPolicyMode(rights: RealizeRightsAgreement): "signed_agreement" | "first_party" { return rights.policy_mode ?? "signed_agreement"; }
function rightsPolicyId(rights: RealizeRightsAgreement): string { return rights.policy_mode === "first_party" ? rights.policy.policy_id : rights.agreement.agreement_id; }
function rightsPolicyVersion(rights: RealizeRightsAgreement): number { return rights.policy_mode === "first_party" ? rights.policy.version : rights.agreement.version; }

function validateRightsPolicy(rights: RealizeRightsAgreement, mode: "signed_agreement" | "first_party", creatorId?: string): boolean {
  if (rightsPolicyMode(rights) !== mode || rights.status !== "active" || rights.effective_now === false) return false;
  if (mode === "first_party") return rights.policy_mode === "first_party" && (!creatorId || rights.policy.creator_id === creatorId) && computeFirstPartyRealizeRightsPolicyHash(rights.policy) === rights.terms_hash;
  return rights.policy_mode !== "first_party" && computeRevenueRightsAgreementHash(rights.agreement as never) === rights.terms_hash;
}

async function getCommission(identity: RealizeIdentity, commissionId: string): Promise<RealizeCommissionStatus> {
  const path = commissionPath(commissionId);
  return api.realizeCommission(commissionId, await signRealizeRequest(identity, "GET", path));
}

function quotePayoutSum(quote: RealizeQuote): bigint {
  return quote.payout_recipients.reduce((sum, recipient) => sum + BigInt(recipient.amount_usdc_atomic), 0n);
}

function quoteComponentsSum(quote: RealizeQuote): bigint {
  return BigInt(quote.provider_base_price_usdc_atomic) + BigInt(quote.character_owner_markup_usdc_atomic) + BigInt(quote.platform_fee_usdc_atomic) + (quote.additional_beneficiaries ?? []).reduce((sum, item) => sum + BigInt(item.amount_usdc_atomic), 0n);
}

function verifyQuote(quote: RealizeQuote, health: {instance_id: string; instance_public_key: string}): boolean {
  try {
    const parsed = RealizeQuoteV1Schema.parse(quote);
    return parsed.issuer_id === health.instance_id && parsed.issuer_public_key === health.instance_public_key && verifyRealizeQuoteSignature(parsed, base64UrlToBytes(health.instance_public_key));
  } catch { return false; }
}

function verifyProvenance(record: RealizeProvenance, quote: RealizeQuote, health: {instance_id: string; instance_public_key: string}): boolean {
  let parsed;
  try { parsed = ProvenanceRecordV1Schema.parse(record); } catch { return false; }
  if (parsed.issuer_id !== health.instance_id || parsed.issuer_key_id !== quote.issuer_key_id || parsed.quote_hash !== quote.canonical_quote_hash || parsed.commission_id !== quote.commission_id) return false;
  const {signature, ...unsigned} = parsed;
  const payload = concatBytes(utf8("vox.realize.provenance.v1"), new Uint8Array([0]), canonicalBytes(unsigned));
  return verifyBytes(payload, signature, base64UrlToBytes(health.instance_public_key));
}

function checkoutError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "creator_not_found" || error.code === "creator_not_configured") return "This creator is not ready to accept commissions yet. Try again once their checkout is available.";
    if (error.code === "quote_expired" || error.code === "pricing_request_expired") return "This quote expired. Request a fresh quote to continue.";
    if (error.code === "rights_party_missing") return "This creator’s active rights terms do not enable private commissioner checkout yet.";
    if (error.code === "payment_unverified") return "Solana has not finalized this payment yet. Your signature is saved; check again shortly and do not pay twice.";
    if (error.code === "payment_configuration_mismatch" || error.code === "payment_not_configured") return "Solana checkout is temporarily unavailable for this creator.";
    if (error.kind === "network") return "Could not reach VOX.gold. Your checkout is saved; reconnect and retry.";
  }
  return error instanceof Error ? error.message : "Request failed. Please retry.";
}

function epochSeconds(expiresAt: string, now: number): string {
  const remaining = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1_000));
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
}

function paymentLabel(status?: string, hasSubmittedSignature = false, progress?: PaymentProgress): string {
  if (status === "captured" || status === "settled") return "Verified by VOX.gold";
  if (status === "pending" || status === "authorized") {
    if (!hasSubmittedSignature) return "Payment not submitted";
    return progress === "solana_confirmation" ? "Confirming on Solana" : "Awaiting VOX verification";
  }
  if (status === "failed" || status === "refund_pending" || status === "refunded") return status.replaceAll("_", " ");
  return "Not started";
}

function generationLabel(status?: string): string {
  if (!status || status === "not_started") return "Not started";
  return status.replaceAll("_", " ").toLowerCase();
}

function commissionTrackingLabel(status?: RealizeCommissionStatus, hasSubmittedSignature = false): string {
  if (!status) return "Commission tracking";
  const {state, payment_state: paymentState, fulfillment_state: fulfillmentState} = status.commission;
  if (state === "SETTLED") return "Your creation is ready and settled";
  if (state === "FAILED" || state === "REFUNDED" || state === "REFUND_PENDING" || fulfillmentState === "failed" || fulfillmentState === "canceled") return "Commission needs attention";
  if (fulfillmentState === "completed") return "Your creation is ready";
  if (state === "AWAITING_PAYMENT" || paymentState === "pending" || paymentState === "authorized") return hasSubmittedSignature ? "Waiting for payment verification" : "Payment not submitted";
  if (state === "FUNDED") return "Payment verified; preparing generation";
  if (state === "GENERATING" && fulfillmentState === "queued") return "Generation is queued";
  if (state === "GENERATING" && fulfillmentState === "generating") return "Generation is in progress";
  if (state === "MANUAL_REVIEW") return "Commission needs review";
  if (state === "EXPIRED") return "Commission expired";
  return "Commission tracking";
}

function isGenerationInProgress(status?: RealizeCommissionStatus): boolean {
  return status?.commission.state === "GENERATING" && ["queued", "generating"].includes(status.commission.fulfillment_state);
}

export function RealizeCheckout({post, posts, agents, initialBrief, onClose}: {post: PostRecord; posts: PostRecord[]; agents: Record<string, AgentRecord>; initialBrief?: {prompt: string; durationSeconds: number} | undefined; onClose: () => void}) {
  const connected = useConnectedWallet(solanaWalletClient);
  const wallets = useWallets(solanaWalletClient);
  const walletStatus = useWalletStatus(solanaWalletClient);
  const creatorOptions = useMemo(() => Object.values(agents).filter((agent) => posts.some((item) => item.intent.agent_id === agent.registration.agent_id)), [agents, posts]);
  const savedCheckout = useMemo(() => {
    const saved = loadSavedCheckout(post.post_id);
    return saved?.originPostId === post.post_id ? saved : undefined;
  }, [post.post_id]);
  const initialPrompt = initialBrief?.prompt ?? (post.intent.content.video_brief ? videoBriefPrompt(post.intent.content.video_brief) : realizePromptFromSearch(window.location.search));
  const initialDescription = savedCheckout?.commissionId && savedCheckout.description.trim() ? savedCheckout.description : initialPrompt ?? post.intent.content.text;
  const [identity, setIdentity] = useState<RealizeIdentity>();
  const [creatorId, setCreatorId] = useState(savedCheckout?.creatorId ?? post.intent.agent_id);
  const [capabilities, setCapabilities] = useState<RealizeCapabilities>();
  const [options, setOptions] = useState<VideoOptions>();
  const [capabilityError, setCapabilityError] = useState("");
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [testVideoMode, setTestVideoMode] = useState(!!savedCheckout?.testVideo);
  const [rights, setRights] = useState<RealizeRightsAgreement>();
  const [description, setDescription] = useState(initialDescription);
  const [style, setStyle] = useState<RealizeStyle>(savedCheckout?.style ?? "cinematic");
  const [duration, setDuration] = useState(savedCheckout?.duration ?? initialBrief?.durationSeconds ?? post.intent.content.video_brief?.duration_seconds ?? 12);
  const [resolution, setResolution] = useState(savedCheckout?.resolution ?? "768P");
  const [quote, setQuote] = useState<RealizeQuote>();
  const [commissionId, setCommissionId] = useState<string>();
  const [commissionStatus, setCommissionStatus] = useState<RealizeCommissionStatus>();
  const [restoringCommission, setRestoringCommission] = useState(!!savedCheckout?.commissionId);
  const [funding, setFunding] = useState<RealizeFunding>();
  const [provenance, setProvenance] = useState<RealizeProvenance>();
  const [quoteContext, setQuoteContext] = useState<string>();
  const [health, setHealth] = useState<{instance_id: string; instance_public_key: string}>();
  const [rightsReviewed, setRightsReviewed] = useState(false);
  const [finePrintOpen, setFinePrintOpen] = useState(false);
  const [publicConsent, setPublicConsent] = useState(false);
  const [publicAttribution, setPublicAttribution] = useState("");
  const [nftPublicationConsent, setNftPublicationConsent] = useState(!!savedCheckout?.nftPublicationConsent);
  const [pendingSignature, setPendingSignature] = useState<string>();
  const [pendingPaymentAttempt, setPendingPaymentAttempt] = useState<UsdcPaymentAttempt | undefined>(savedCheckout?.paymentAttempt);
  const [financialAttemptId, setFinancialAttemptId] = useState<string | undefined>(savedCheckout?.financialAttemptId);
  const [walletReceipt, setWalletReceipt] = useState("");
  const [pendingRefundSignature, setPendingRefundSignature] = useState<string>();
  const [transactionUrl, setTransactionUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [paymentProgress, setPaymentProgress] = useState<PaymentProgress>();
  const [capabilityLoading, setCapabilityLoading] = useState(true);
  const [identityLoading, setIdentityLoading] = useState(true);
  const [error, setError] = useState("");
  const [quoteError, setQuoteError] = useState("");
  const [trackingError, setTrackingError] = useState("");
  const [now, setNow] = useState(Date.now());
  const restoreOnce = useRef(false);
  const loadedCreator = useRef(creatorId);
  const quoteReviewRef = useRef<HTMLElement | null>(null);
  const scrollToQuoteRef = useRef(false);
  const financialRecord = useRef<FinancialCheckpoint<SavedCheckout>>();
  const selectedCreator = creatorOptions.find((item) => item.registration.agent_id === creatorId);
  const connectedAddress = connected?.account.address;
  const testVideoCapabilityAvailable = !!capabilities?.capabilities.some((item) => item.capability_id === REALIZE_TEST_VIDEO_CAPABILITY_ID && item.output_media_types.includes("video/mp4")) && !!capabilities?.generation_provider_ids.includes(REALIZE_TEST_VIDEO_PROVIDER_ID);
  const selectedCapability = capabilities?.capabilities.find((item) => item.output_media_types.includes("video/mp4") && (testVideoMode ? item.capability_id === REALIZE_TEST_VIDEO_CAPABILITY_ID : item.capability_id !== REALIZE_TEST_VIDEO_CAPABILITY_ID));
  const effectiveDescription = testVideoMode ? REALIZE_TEST_VIDEO_REQUEST.concept : description.trim();
  const effectiveStyle = testVideoMode ? REALIZE_TEST_VIDEO_REQUEST.style : style;
  const effectiveDuration = testVideoMode ? REALIZE_TEST_VIDEO_REQUEST.duration_seconds : duration;
  const effectiveResolution = testVideoMode ? REALIZE_TEST_VIDEO_REQUEST.resolution : resolution;
  const quoteMatches = !!quote && quoteContext === JSON.stringify([creatorId, effectiveDescription, effectiveStyle, effectiveDuration, effectiveResolution, testVideoMode]);
  const quoteExpired = !!quote && Date.parse(quote.expires_at) <= now;
  const quoteValid = !!quote && !!health && verifyQuote(quote, health) && quoteComponentsSum(quote) === BigInt(quote.total_amount_usdc_atomic) && quotePayoutSum(quote) === BigInt(quote.total_amount_usdc_atomic);
  const quoteAccepted = !!commissionStatus?.commission.accepted_quote_hash && commissionStatus.commission.accepted_quote_hash === quote?.canonical_quote_hash;
  const paymentPending = (!!pendingSignature || !!pendingPaymentAttempt) && commissionStatus?.commission.payment_state !== "captured" && commissionStatus?.commission.payment_state !== "settled";
  const networkName = quote?.network_id?.replace("solana:", "") ?? "";
  const mainnetRealizeDisabled = networkName === "mainnet-beta" && import.meta.env.VITE_REALIZE_MAINNET_ENABLED !== "true";
  const expectedChain = walletChainForCluster(networkName);
  const networkMismatch = !!quote && !!expectedChain && configuredWalletCluster() !== networkName;
  const walletChainMismatch = !!quote && !!connected && !!expectedChain && !connected.account.chains.includes(expectedChain as never);
  const payerWalletMismatch = !!quoteAccepted && !!funding && !!connected && connected.account.address !== funding.payer_wallet;
  const paymentIsVerified = ["captured", "settled"].includes(commissionStatus?.commission.payment_state ?? "");
  const currentTermsMatchQuote = !quote || (!!rights && rightsPolicyMode(rights) === (quote.rights_policy_mode ?? "signed_agreement") && rightsPolicyId(rights) === quote.rights_agreement_reference && rights.terms_hash === quote.rights_agreement_hash && rightsPolicyVersion(rights) === quote.rights_agreement_version && validateRightsPolicy(rights, quote.rights_policy_mode ?? "signed_agreement", quote.creator_id));
  const canAcceptQuote = !!quote && quoteMatches && quoteValid && !quoteExpired && !mainnetRealizeDisabled && currentTermsMatchQuote && !!rights && rightsReviewed && !!connectedAddress && !quoteAccepted && !busy;
  const attributionReady = !publicConsent || !!publicAttribution.trim();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!quote || !scrollToQuoteRef.current) return;
    scrollToQuoteRef.current = false;
    quoteReviewRef.current?.scrollIntoView({behavior: "smooth", block: "start"});
  }, [quote]);

  useEffect(() => {
    let active = true;
    void getRealizeIdentity().then((value) => { if (active) setIdentity(value); }).catch((reason: unknown) => { if (active) setError(checkoutError(reason)); }).finally(() => { if (active) setIdentityLoading(false); });
    void api.health().then((value) => { if (active) setHealth(value); }).catch((reason: unknown) => { if (active) setError(checkoutError(reason)); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setCapabilityLoading(true);
    setCapabilityError("");
    setCapabilities(undefined);
    setOptions(undefined);
    setRights(undefined);
    if (loadedCreator.current !== creatorId) {
      setQuote(undefined);
      setQuoteContext(undefined);
      setCommissionId(undefined);
      setCommissionStatus(undefined);
      setFunding(undefined);
      setProvenance(undefined);
      setPendingSignature(undefined);
      setPendingPaymentAttempt(undefined);
      setPendingRefundSignature(undefined);
      setTransactionUrl(undefined);
      setRightsReviewed(false);
      loadedCreator.current = creatorId;
    }
    if (!creatorId) { setCapabilityLoading(false); return; }
    void api.realizeCapabilities(creatorId).then(async (value) => {
      if (!active) return;
      setCapabilities(value);
      if (testVideoMode && (!value.generation_provider_ids.includes(REALIZE_TEST_VIDEO_PROVIDER_ID) || !value.capabilities.some((item) => item.capability_id === REALIZE_TEST_VIDEO_CAPABILITY_ID && item.output_media_types.includes("video/mp4")))) throw new Error("Populi’s prerecorded integration-test checkout is not available for this creator yet.");
      const capability = value.capabilities.find((item) => item.output_media_types.includes("video/mp4") && (testVideoMode ? item.capability_id === REALIZE_TEST_VIDEO_CAPABILITY_ID : item.capability_id !== REALIZE_TEST_VIDEO_CAPABILITY_ID));
      if (!capability) throw new Error(testVideoMode ? "Populi’s prerecorded integration-test checkout is not available for this creator yet." : "This creator does not currently offer video commissions.");
      const schema = await api.realizeInputSchema(creatorId, capability.capability_id);
      if (!active) return;
      const controls = videoOptions(schema, capability.max_duration_seconds);
      setOptions(controls);
      if (!savedCheckout?.commissionId || savedCheckout.creatorId !== creatorId) {
        setDuration((current) => controls.durations.includes(current) ? current : controls.durations[0]!);
        setResolution((current) => controls.resolutions.includes(current) ? current : controls.resolutions[0] ?? "");
      }
      const agreementId = value.rights_agreement_references?.[0];
      if (!agreementId) throw new Error("This creator has no active rights agreement for commissions.");
      const terms = await api.realizeRights(agreementId);
      const mode = value.rights_policy_mode ?? "signed_agreement";
      if (!validateRightsPolicy(terms, mode, creatorId)) throw new Error(mode === "first_party" ? "This first-party creator policy could not be verified." : "This creator’s rights agreement is not active or its terms could not be verified.");
      if (!active) return;
      setRights(terms);
    }).catch((reason: unknown) => { if (active) setCapabilityError(checkoutError(reason)); }).finally(() => { if (active) setCapabilityLoading(false); });
    return () => { active = false; };
  }, [creatorId, capabilityAttempt, testVideoMode]);

  const refreshStatus = useCallback(async (id: string, signer: RealizeIdentity) => {
    const financialAtRequest = financialRecord.current?.commissionId === id ? financialRecord.current : undefined;
    const updated = await getCommission(signer, id);
    setCommissionStatus(updated);
    if (updated.quote) {
      const trusted = health ?? await api.health();
      if (!health) setHealth(trusted);
      if (!verifyQuote(updated.quote, trusted)) throw new Error("VOX.gold returned a quote with an invalid signature or issuer.");
      setQuote(updated.quote);
      const parameters = updated.quote.requested_generation_parameters;
      const savedContext = JSON.stringify([updated.quote.creator_id, generationDescription(parameters).trim(), String(parameters.style ?? "cinematic"), Number(parameters.duration_seconds ?? 12), String(parameters.resolution ?? ""), updated.quote.capability_id === REALIZE_TEST_VIDEO_CAPABILITY_ID]);
      setQuoteContext(savedContext);
      const terms = await api.realizeRights(updated.quote.rights_agreement_reference, updated.quote.rights_agreement_version);
      if (terms.terms_hash !== updated.quote.rights_agreement_hash || !validateRightsPolicy(terms, updated.quote.rights_policy_mode ?? "signed_agreement", updated.quote.creator_id)) throw new Error("The accepted quote no longer matches its active rights policy.");
      setRights(terms);
    }
    if (updated.funding) setFunding(updated.funding);
    if (updated.provenance_record_id && updated.quote) {
      const record = await api.realizeProvenance(updated.provenance_record_id);
      const trusted = health ?? await api.health();
      if (verifyProvenance(record, updated.quote, trusted)) setProvenance(record);
      else throw new Error("The provenance signature could not be verified against this VOX.gold issuer.");
    }
    if (updated.commission.accepted_quote_hash) setRightsReviewed(true);
    if (financialAtRequest?.outcome === "pending" && ["captured", "settled"].includes(updated.commission.payment_state)) {
      const {transactionSignature: _signature, paymentAttempt: _attempt, ...checkout} = financialAtRequest.checkout;
      try {
        const resolved = await writeFinancialCheckpoint({...financialAtRequest, outcome: "captured", updatedAt: Date.now(), checkout}, {expectedAttemptId: financialAtRequest.attemptId});
        if (financialRecord.current?.attemptId === financialAtRequest.attemptId) {
          financialRecord.current = resolved;
          saveCheckout(checkout);
          setPendingSignature(undefined);
          setPendingPaymentAttempt(undefined);
        }
      } catch { /* A newer attempt or unavailable durable storage must not be erased. */ }
    }
    setTrackingError("");
    return updated;
  }, [health]);

  function paymentCheckpoint(expectedAttemptId?: string): SavedCheckout | undefined {
    const durable = financialRecord.current;
    const saved = durable && durable.commissionId === commissionId && (!expectedAttemptId || durable.attemptId === expectedAttemptId) ? durable.checkout : loadSavedCheckout(post.post_id, commissionId);
    return saved && (!expectedAttemptId || saved.financialAttemptId === expectedAttemptId) ? saved : undefined;
  }

  async function persistFinancial(checkout: SavedCheckout, outcome: FinancialOutcome, options: {startAttempt?: boolean; expectedAttemptId?: string; expectedSignature?: string} = {}): Promise<void> {
    if (!checkout.commissionId || !checkout.financialAttemptId) throw new Error("The financial recovery checkpoint is missing; reopen this checkout before paying.");
    const record: FinancialCheckpoint<SavedCheckout> = {sourcePostId: checkout.originPostId, commissionId: checkout.commissionId, attemptId: checkout.financialAttemptId, outcome, updatedAt: Date.now(), checkout};
    financialRecord.current = await writeFinancialCheckpoint(record, {
      ...options,
      ...(checkout.financialPredecessor ? {predecessorCommissionId: checkout.financialPredecessor} : {}),
      ...(!options.startAttempt ? {expectedAttemptId: checkout.financialAttemptId} : {})
    });
    // IndexedDB is the durable authority. The old session registry is retained
    // for draft compatibility and cannot overwrite another tab's financial data.
    saveCheckout(checkout);
    setFinancialAttemptId(checkout.financialAttemptId);
  }

  async function resolveFinancial(outcome: Exclude<FinancialOutcome, "pending">, expectedAttemptId: string | undefined, signature?: string): Promise<void> {
    if (expectedAttemptId && financialRecord.current?.attemptId === expectedAttemptId && financialRecord.current.outcome === outcome) {
      setPendingSignature(undefined);
      setPendingPaymentAttempt(undefined);
      return;
    }
    const saved = paymentCheckpoint(expectedAttemptId);
    if (!saved) throw new Error("Another tab has a newer payment for this order. Reopen its saved checkout before continuing.");
    const {transactionSignature: _signature, paymentAttempt: _paymentAttempt, ...resolved} = saved;
    if (expectedAttemptId) await persistFinancial(resolved, outcome, signature ? {expectedSignature: signature} : {});
    else saveCheckout(resolved);
    setPendingSignature(undefined);
    setPendingPaymentAttempt(undefined);
  }

  async function restoreCheckout(saved: SavedCheckout, record?: FinancialCheckpoint<SavedCheckout>): Promise<void> {
    if (!validSavedCheckout(saved) || record && (saved.originPostId !== record.sourcePostId || saved.commissionId !== record.commissionId || saved.financialAttemptId !== record.attemptId)) throw new Error("The durable payment checkpoint is invalid. Verify the original wallet receipt before continuing.");
    if (record) financialRecord.current = record;
    saveCheckout(saved);
    loadedCreator.current = saved.creatorId;
    setCreatorId(saved.creatorId);
    setDescription(saved.description);
    setStyle(saved.style);
    setDuration(saved.duration);
    setResolution(saved.resolution ?? "768P");
    setTestVideoMode(saved.testVideo === true);
    setPublicAttribution(saved.publicAttribution ?? "");
    setPublicConsent(!!saved.publicAttribution);
    setNftPublicationConsent(saved.nftPublicationConsent === true);
    setCommissionId(saved.commissionId);
    setPendingSignature(saved.transactionSignature);
    setPendingPaymentAttempt(saved.paymentAttempt);
    setFinancialAttemptId(saved.financialAttemptId);
    setPendingRefundSignature(saved.refundTransactionSignature);
    setTransactionUrl(saved.transactionUrl);
    setRestoringCommission(true);
    try { if (saved.commissionId && identity) await refreshStatus(saved.commissionId, identity); }
    finally { setRestoringCommission(false); }
  }

  useEffect(() => {
    if (!identity || restoreOnce.current) return;
    restoreOnce.current = true;
    setRestoringCommission(true);
    void (async () => {
      await migrateFinancialCheckpoints();
      const durable = await readFinancialCheckpoint<SavedCheckout>(post.post_id);
      financialRecord.current = durable;
      const session = loadSavedCheckout(post.post_id);
      const useDurable = durable && (durable.outcome === "pending" || !session || session.commissionId === durable.commissionId || session.financialPredecessor !== durable.commissionId);
      const saved = useDurable ? durable.checkout : session;
      if (saved?.originPostId === post.post_id) await restoreCheckout(saved, useDurable ? durable : undefined);
    })().catch((reason: unknown) => setError(`Could not restore this commission. ${checkoutError(reason)}`)).finally(() => setRestoringCommission(false));
  }, [identity, post.post_id, refreshStatus]);

  useEffect(() => {
    if (!savedCheckout?.commissionId || savedCheckout.creatorId !== creatorId || !options || !commissionStatus || restoringCommission) return;
    const {commission, quote: savedQuote} = commissionStatus;
    if (["SETTLED", "REFUNDED", "EXPIRED"].includes(commission.state) || pendingSignature || pendingPaymentAttempt || pendingRefundSignature) return;
    if (savedQuote && Date.parse(savedQuote.expires_at) > Date.now()) return;
    if (commission.accepted_quote_hash && !quoteExpired) return;
    setDuration((current) => options.durations.includes(current) ? current : options.durations[0]!);
    setResolution((current) => options.resolutions.includes(current) ? current : options.resolutions[0] ?? "");
  }, [savedCheckout, creatorId, options, commissionStatus, restoringCommission, pendingSignature, pendingPaymentAttempt, pendingRefundSignature, quoteExpired]);

  useEffect(() => {
    if (!identity || !commissionId || !commissionStatus || ["SETTLED", "REFUNDED", "EXPIRED"].includes(commissionStatus.commission.state)) return;
    let active = true;
    const timer = window.setInterval(() => {
      void refreshStatus(commissionId, identity).catch((reason: unknown) => { if (active) setTrackingError(checkoutError(reason)); });
    }, 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [identity, commissionId, commissionStatus?.commission.state, refreshStatus]);

  function invalidateQuote(): void {
    if (paymentPending) return;
    setQuoteError("");
    if (!quoteAccepted) {
      setQuote(undefined);
      setQuoteContext(undefined);
      setCommissionId(undefined);
      setCommissionStatus(undefined);
      setFunding(undefined);
      setRightsReviewed(false);
      clearCheckout(post.post_id);
    }
  }

  function setIntegrationTestCheckout(enabled: boolean): void {
    if (enabled === testVideoMode || restoringCommission || busy || paymentPending || quoteAccepted && !quoteExpired) return;
    setTestVideoMode(enabled);
    setQuote(undefined);
    setQuoteContext(undefined);
    setCommissionId(undefined);
    setCommissionStatus(undefined);
    setFunding(undefined);
    setProvenance(undefined);
    setRightsReviewed(false);
    setNftPublicationConsent(false);
    setPendingSignature(undefined);
    setPendingRefundSignature(undefined);
    setTransactionUrl(undefined);
    setError("");
    clearCheckout(post.post_id);
  }

  async function connectWallet(wallet: typeof wallets[number]): Promise<void> {
    setError("");
    try { await solanaWalletClient.wallet.connect(wallet); }
    catch (reason) { setError(walletRejected(reason) ? "Wallet connection canceled. Choose a wallet and try again." : checkoutError(reason)); }
  }

  async function requestQuote(): Promise<void> {
    if (restoringCommission || busy || paymentPending || !identity || !rights || !selectedCreator || !selectedCapability || !options || (quoteAccepted && !quoteExpired)) return;
    setQuoteError("");
    const cleanDescription = testVideoMode ? REALIZE_TEST_VIDEO_REQUEST.concept : description.trim();
    if (!cleanDescription) { setQuoteError("Add a short description of the video you want."); return; }
    if (!testVideoMode && (cleanDescription.length < options.minDescriptionLength || cleanDescription.length > options.maxDescriptionLength)) { setQuoteError(`Please use ${options.minDescriptionLength}–${options.maxDescriptionLength} characters.`); return; }
    if (!testVideoMode && (!options.durations.includes(duration) || options.resolutions.length > 0 && !options.resolutions.includes(resolution))) { setQuoteError("Choose one of the available video settings."); return; }
    if (testVideoMode && !testVideoCapabilityAvailable) { setQuoteError("The prerecorded checkout is not available yet."); return; }
    if (capabilityLoading || rights.status !== "active") { setQuoteError("This creator’s checkout is still getting ready. Try again in a moment."); return; }
    const covered = rights.policy_mode === "first_party" || rights.agreement.parties.some((party) => party.party_id === identity.humanId && party.role === "commissioner") || rights.agreement.parties.some((party) => party.party_id === REALIZE_COMMISSIONER_ROLE_PARTY_ID && party.role === "commissioner");
    if (!covered) { setQuoteError("This creator’s active rights terms do not enable private checkout yet."); return; }
    setBusy(true);
    setError("");
    setQuote(undefined);
    setCommissionId(undefined);
    setCommissionStatus(undefined);
    setFunding(undefined);
    setProvenance(undefined);
    setRightsReviewed(false);
    setNftPublicationConsent(false);
    setPendingSignature(undefined);
    const idempotencyKey = crypto.randomUUID();
    const pricingRequestId = `vox:pricing:${crypto.randomUUID()}`;
    const params = testVideoMode ? {...REALIZE_TEST_VIDEO_REQUEST} : {[options.descriptionField]: cleanDescription, ...(options.supportsStyle ? {style} : {}), duration_seconds: duration, ...(options.resolutions.length ? {resolution} : {})};
    const agreementReference = rightsPolicyId(rights);
    const createBody = {commissioner_id: identity.humanId, creator_id: creatorId, capability_id: selectedCapability.capability_id, requested_generation_parameters: params, rights_agreement_reference: agreementReference, source_post_id: post.post_id};
    const savedBase: SavedCheckout = {version: 2, originPostId: post.post_id, creatorId, description: cleanDescription, style, duration: testVideoMode ? REALIZE_TEST_VIDEO_REQUEST.duration_seconds : duration, resolution: testVideoMode ? REALIZE_TEST_VIDEO_REQUEST.resolution : resolution, testVideo: testVideoMode, idempotencyKey, requestId: pricingRequestId, ...(financialRecord.current ? {financialPredecessor: financialRecord.current.commissionId} : {})};
    saveCheckout(savedBase);
    try {
      const createPath = "/v1/realize/commissions";
      const signedCreateBody = {request: createBody, idempotency_key: idempotencyKey};
      const commission = await api.createRealizeCommission(createBody, idempotencyKey, await signRealizeRequest(identity, "POST", createPath, signedCreateBody));
      setCommissionId(commission.commission_id);
      saveCheckout({...savedBase, commissionId: commission.commission_id});
      const pricingBody = {
        protocol_version: "realize/1",
        request_id: pricingRequestId,
        commission_id: commission.commission_id,
        requester_id: identity.humanId,
        creator_id: creatorId,
        capability_id: selectedCapability.capability_id,
        ...(testVideoMode ? {generation_provider_id: REALIZE_TEST_VIDEO_PROVIDER_ID} : capabilities?.generation_provider_ids.find((providerId) => providerId !== REALIZE_TEST_VIDEO_PROVIDER_ID) ? {generation_provider_id: capabilities.generation_provider_ids.find((providerId) => providerId !== REALIZE_TEST_VIDEO_PROVIDER_ID)} : {}),
        requested_generation_parameters: params,
        rights_agreement_reference: agreementReference,
        requested_at: new Date().toISOString()
      };
      const quotes = await api.requestRealizeQuote(pricingBody, await signRealizeRequest(identity, "POST", "/v1/realize/pricing-requests", pricingBody));
      const issued = quotes.quotes[0];
      const trusted = health ?? await api.health();
      if (!health) setHealth(trusted);
      if (!issued || !verifyQuote(issued, trusted) || issued.commission_id !== commission.commission_id || issued.creator_id !== creatorId || issued.capability_id !== selectedCapability.capability_id || issued.rights_agreement_reference !== agreementReference || issued.rights_agreement_hash !== rights.terms_hash || (issued.rights_policy_mode ?? "signed_agreement") !== rightsPolicyMode(rights) || quoteComponentsSum(issued) !== BigInt(issued.total_amount_usdc_atomic) || quotePayoutSum(issued) !== BigInt(issued.total_amount_usdc_atomic)) throw new Error("VOX.gold returned a quote that failed signature, rights, price or commission validation.");
      scrollToQuoteRef.current = true;
      setQuote(issued);
      setQuoteContext(JSON.stringify([creatorId, cleanDescription, testVideoMode ? REALIZE_TEST_VIDEO_REQUEST.style : style, testVideoMode ? REALIZE_TEST_VIDEO_REQUEST.duration_seconds : duration, testVideoMode ? REALIZE_TEST_VIDEO_REQUEST.resolution : resolution, testVideoMode]));
      setCommissionStatus({commission, quote: issued, settlement_status: "not_started"});
      setError("");
      setQuoteError("");
      saveCheckout({...savedBase, commissionId: commission.commission_id});
    } catch (reason) { setQuoteError(checkoutError(reason)); }
    finally { setBusy(false); }
  }

  async function acceptQuote(): Promise<void> {
    if (!identity || !quote || !commissionId || !canAcceptQuote || !attributionReady) return;
    setBusy(true);
    setError("");
    try {
      if (!connectedAddress) throw new Error("Connect a Solana wallet before accepting this quote.");
      if (networkMismatch || walletChainMismatch) throw new Error(`Switch your wallet to Solana ${networkName} before accepting this quote.`);
      const body = {quote_id: quote.quote_id, canonical_quote_hash: quote.canonical_quote_hash, payer_wallet: connectedAddress, rights_reviewed: true, nft_publication_consent: nftPublicationConsent, ...(publicConsent && publicAttribution.trim() ? {public_attribution: publicAttribution.trim()} : {})};
      const path = `${commissionPath(commissionId)}/accept-quote`;
      // Acceptance may succeed even when its response or the following status
      // request is lost. Retain the exact consent sent before crossing that boundary.
      saveCheckout({version: 2, originPostId: post.post_id, creatorId, description: description.trim(), style, duration, resolution, testVideo: testVideoMode, idempotencyKey: loadSavedCheckout(post.post_id, commissionId)?.idempotencyKey ?? crypto.randomUUID(), requestId: quote.pricing_request_id, commissionId, nftPublicationConsent, ...(financialRecord.current ? {financialPredecessor: financialRecord.current.commissionId} : {}), ...(publicConsent && publicAttribution.trim() ? {publicAttribution: publicAttribution.trim()} : {})});
      const accepted = await api.acceptRealizeQuote(commissionId, body, await signRealizeRequest(identity, "POST", path, body));
      setFunding(accepted.funding);
      const updated = await refreshStatus(commissionId, identity);
      setCommissionStatus(updated);
    } catch (reason) { setError(checkoutError(reason)); }
    finally { setBusy(false); }
  }

  async function submitFunding(signature: string, expectedAttemptId = financialAttemptId): Promise<void> {
    if (!identity || !commissionId || !funding) return;
    setBusy(true);
    setPaymentProgress("vox_verification");
    setError("");
    try {
      const body = {payer_wallet: funding.payer_wallet, transaction_signature: signature};
      const path = `${commissionPath(commissionId)}/fund`;
      await api.fundRealizeCommission(commissionId, body, await signRealizeRequest(identity, "POST", path, body));
      setPendingSignature(signature);
      const updated = await refreshStatus(commissionId, identity);
      if (["captured", "settled"].includes(updated.commission.payment_state)) {
        await resolveFinancial("captured", expectedAttemptId, signature);
      }
    } catch (reason) {
      setPendingSignature(signature);
      setError(checkoutError(reason));
      try {
        const updated = await refreshStatus(commissionId, identity);
        if (["captured", "settled"].includes(updated.commission.payment_state)) {
          await resolveFinancial("captured", expectedAttemptId, signature);
        }
      } catch { /* The signed transaction remains saved for a later check. */ }
    } finally { setBusy(false); }
  }

  async function pay(): Promise<void> {
    if (busy || restoringCommission) return;
    setBusy(true);
    setError("");
    try {
      await withFinancialLock(post.post_id, async () => {
        const durable = await readFinancialCheckpoint<SavedCheckout>(post.post_id);
        const saved = loadSavedCheckout(post.post_id, commissionId);
        if (durable && (durable.outcome === "pending" || durable.commissionId === commissionId && durable.outcome === "captured" || durable.commissionId !== commissionId && saved?.financialPredecessor !== durable.commissionId)) {
          await restoreCheckout(durable.checkout, durable);
          setError("This source already has a saved payment. Check its existing transaction before paying again.");
          return;
        }
        await payLocked(durable);
      });
    } catch (reason) { setError(checkoutError(reason)); }
    finally { setBusy(false); }
  }

  async function payLocked(previousRecord?: FinancialCheckpoint<SavedCheckout>): Promise<void> {
    if (!identity || !quote || !funding || !commissionId || !connected || !quoteAccepted || quoteExpired || busy || paymentPending) return;
    if (mainnetRealizeDisabled) { setError("Realize Mainnet checkout is disabled in this web build."); return; }
    if (networkMismatch) { setError(`This checkout is configured for ${networkName}, but the wallet connector is configured for ${configuredWalletCluster()}.`); return; }
    if (walletChainMismatch) { setError(`Wrong network. Switch the wallet to Solana ${networkName} and reconnect.`); return; }
    if (connected.account.address !== funding.payer_wallet) { setError(`Reconnect the wallet that accepted this quote: ${funding.payer_wallet}.`); return; }
    if (!connected.account.chains.includes(expectedChain as never)) { setError(`Connect a wallet on Solana ${networkName}.`); return; }
    setBusy(true);
    setPaymentProgress("preparing");
    setError("");
    let paymentSubmitted = false;
    let preparedAttempt: UsdcPaymentAttempt | undefined;
    let financialStarted = false;
    const attemptId = crypto.randomUUID();
    try {
      const onWalletApprovalRequested = () => setPaymentProgress("wallet_approval");
      const onPrepared = async (attempt: UsdcPaymentAttempt) => {
        const saved = paymentCheckpoint();
        if (!saved) throw new Error("The payment recovery checkpoint is missing. Reopen this checkout before paying; no payment was sent.");
        const signedRecovery = attempt.kind === "signed" ? {transactionSignature: attempt.signature, transactionUrl: `https://explorer.solana.com/tx/${encodeURIComponent(attempt.signature)}?cluster=${encodeURIComponent(networkName)}`} : {};
        // This write must succeed before the RPC or a sign-and-send wallet can
        // broadcast. Draft persistence elsewhere is deliberately best effort.
        await persistFinancial({...saved, financialAttemptId: attemptId, paymentAttempt: attempt, ...signedRecovery}, "pending", {startAttempt: true, ...(previousRecord?.commissionId === commissionId ? {expectedAttemptId: previousRecord.attemptId} : {})});
        financialStarted = true;
        preparedAttempt = attempt;
        paymentSubmitted = true;
        setPendingPaymentAttempt(attempt);
        if (attempt.kind === "signed") {
          setPendingSignature(attempt.signature);
          setTransactionUrl(signedRecovery.transactionUrl);
        }
      };
      const onSubmitted = async (signature: string, url: string) => {
        paymentSubmitted = true;
        setPaymentProgress("solana_confirmation");
        setPendingSignature(signature);
        setTransactionUrl(url);
        const saved = paymentCheckpoint(financialStarted ? attemptId : undefined);
        if (saved) {
          // A real wallet response supplies the missing identity. A manually
          // entered receipt keeps the unresolved marker until API verification.
          const {paymentAttempt, ...checkpoint} = saved;
          await persistFinancial({...checkpoint, financialAttemptId: attemptId, ...(paymentAttempt?.kind === "signed" ? {paymentAttempt} : {}), transactionSignature: signature, transactionUrl: url}, "pending", !financialStarted ? {startAttempt: true, ...(previousRecord?.commissionId === commissionId ? {expectedAttemptId: previousRecord.attemptId} : {})} : {});
          financialStarted = true;
          if (paymentAttempt?.kind === "wallet_submission") setPendingPaymentAttempt(undefined);
        }
      };
      const sent = funding.mode === "escrow"
        ? await sendRealizeEscrowPayment({wallet: connected.wallet, account: connected.account, supportedTransactionVersions: connected.supportedTransactionVersions, payerAddress: connected.account.address, commission: commissionStatus!.commission, quote, issuerPublicKey: quote.issuer_public_key, funding, cluster: networkName, onWalletApprovalRequested, onSubmitted})
        : await sendUsdcPayment({wallet: connected.wallet, account: connected.account, supportedTransactionVersions: connected.supportedTransactionVersions, payerAddress: connected.account.address, usdcMint: funding.usdc_mint, destinationTokenAccount: funding.destination_token_account, destinationOwnerAddress: funding.destination_owner, amountAtomic: funding.amount_usdc_atomic, paymentReference: funding.payment_reference, cluster: networkName, onWalletApprovalRequested, onPrepared, onSubmitted});
      if (sent.confirmation === "failed") {
        paymentSubmitted = false;
        setPaymentProgress(undefined);
        await resolveFinancial("failed", attemptId, sent.signature);
        if (identity && commissionId) await refreshStatus(commissionId, identity).catch(() => undefined);
        throw new Error("The Solana transaction failed. No commission was funded; request a fresh quote before retrying.");
      }
      if (sent.confirmation === "pending") {
        setPaymentProgress("solana_confirmation");
        setPendingSignature(sent.signature);
        await refreshStatus(commissionId, identity).catch(() => undefined);
        setError("Payment confirmation is delayed. Your transaction signature is saved; check its status before continuing and do not pay again.");
        return;
      }
      // A wallet response is only a submitted transaction. The authenticated API
      // independently verifies finalized chain state before payment becomes captured.
      setPaymentProgress("vox_verification");
      await submitFunding(sent.signature, attemptId);
    } catch (reason) {
      if (preparedAttempt?.kind === "wallet_submission" && walletRejected(reason)) {
        await resolveFinancial("rejected", attemptId);
        paymentSubmitted = false;
      }
      if (!paymentSubmitted) setPaymentProgress(undefined);
      setError(walletRejected(reason) ? "Payment canceled in your wallet. No commission was funded." : preparedAttempt?.kind === "wallet_submission" ? "Your wallet may have sent this payment before its response was lost. Do not pay again. Verify the transaction from your wallet history below." : checkoutError(reason));
    }
    finally {
      setBusy(false);
      if (!paymentSubmitted) setPaymentProgress(undefined);
    }
  }

  async function checkPayment(): Promise<void> {
    if (pendingPaymentAttempt?.kind === "signed" && funding?.mode === "direct" && quoteValid) {
      setBusy(true);
      setError("");
      try {
        const checked = await recoverUsdcPayment(pendingPaymentAttempt, {payerAddress: funding.payer_wallet, usdcMint: funding.usdc_mint, destinationTokenAccount: funding.destination_token_account, destinationOwnerAddress: funding.destination_owner, amountAtomic: funding.amount_usdc_atomic, paymentReference: funding.payment_reference, cluster: networkName}, {quoteExpiresAt: quote!.expires_at});
        if (checked.confirmation === "failed") {
          await resolveFinancial("failed", financialAttemptId, checked.signature);
          setError("The Solana transaction failed. No commission was funded; request a fresh quote before retrying.");
        } else await submitFunding(checked.signature);
      } catch (reason) { setError(checkoutError(reason)); }
      finally { setBusy(false); }
      return;
    }
    if (pendingRefundSignature && funding?.mode === "escrow") {
      const chainStatus = await checkSolanaTransaction(pendingRefundSignature, networkName);
      if (chainStatus === "pending") return;
      if (chainStatus === "failed") {
        setPendingRefundSignature(undefined);
        const saved = loadSavedCheckout(post.post_id, commissionId);
        if (saved) { const {refundTransactionSignature: _signature, ...withoutSignature} = saved; saveCheckout(withoutSignature); }
        setError("The refund transaction failed. Your escrow remains available to claim; refresh its status and try again.");
        return;
      }
      await submitRefund(pendingRefundSignature);
      return;
    }
    if (pendingSignature && funding?.mode === "escrow") {
      const chainStatus = await checkSolanaTransaction(pendingSignature, networkName);
      if (chainStatus === "pending") return;
      if (chainStatus === "failed") {
        await resolveFinancial("failed", financialAttemptId, pendingSignature);
        if (commissionId && identity) await refreshStatus(commissionId, identity).catch(() => undefined);
        setError("The Solana transaction failed. Refresh the escrow status before trying again.");
        return;
      }
      if (commissionId && identity) {
        const updated = await refreshStatus(commissionId, identity);
        const onchainStatus = updated.funding?.mode === "escrow" ? updated.funding.progress?.status : undefined;
        if (["captured", "settled"].includes(updated.commission.payment_state) || ["Absent", "Draft", "Ready"].includes(onchainStatus ?? "Absent")) {
          await resolveFinancial(["captured", "settled"].includes(updated.commission.payment_state) ? "captured" : "failed", financialAttemptId, pendingSignature);
        }
      }
    }
    else if (pendingSignature) await submitFunding(pendingSignature);
    else if (commissionId && identity) {
      try { await refreshStatus(commissionId, identity); }
      catch (reason) { setError(checkoutError(reason)); }
    }
  }

  async function verifyWalletReceipt(): Promise<void> {
    if (busy || pendingPaymentAttempt?.kind !== "wallet_submission" || funding?.mode !== "direct") return;
    const signature = walletReceipt.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
      setError("Paste the Solana transaction signature from this payment in your wallet history.");
      return;
    }
    const saved = paymentCheckpoint(financialAttemptId);
    if (!saved) return;
    setBusy(true);
    setError("");
    try {
      // Do not pin an accidentally mistyped, nonexistent receipt in the server's
      // durable submission reservation. Only finalized receipts reach the API.
      const chainStatus = await checkSolanaTransaction(signature, networkName);
      if (chainStatus !== "finalized") {
        setError(chainStatus === "failed" ? "That receipt records a failed Solana transaction. Check this payment in your wallet history before continuing; do not pay again." : "Solana has not finalized this receipt yet. Check the signature in your wallet history and try again; do not pay again.");
        return;
      }
      await persistFinancial({...saved, transactionSignature: signature}, "pending");
      setPendingSignature(signature);
      // The authenticated API checks the quote intent, payer, mint, amount,
      // treasury and finality. Pasting an unrelated receipt cannot unlock payment.
      await submitFunding(signature);
    } catch (reason) { setError(checkoutError(reason)); }
    finally { setBusy(false); }
  }

  async function submitRefund(signature: string): Promise<void> {
    if (!identity || !commissionId || !funding || funding.mode !== "escrow" || !connectedAddress) return;
    setBusy(true);
    setError("");
    try {
      const body = {payer_wallet: connectedAddress, transaction_signature: signature};
      const path = `${commissionPath(commissionId)}/refund`;
      await api.refundRealizeCommission(commissionId, body, await signRealizeRequest(identity, "POST", path, body));
      const updated = await refreshStatus(commissionId, identity);
      setCommissionStatus(updated);
      setPendingRefundSignature(undefined);
      const saved = loadSavedCheckout(post.post_id, commissionId);
      if (saved) { const {refundTransactionSignature: _signature, ...withoutSignature} = saved; saveCheckout(withoutSignature); }
    } catch (reason) {
      setPendingRefundSignature(signature);
      const saved = loadSavedCheckout(post.post_id, commissionId);
      if (saved) saveCheckout({...saved, refundTransactionSignature: signature});
      setError(checkoutError(reason));
      await refreshStatus(commissionId, identity).catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function claimRefund(): Promise<void> {
    if (!identity || !commissionId || !quote || !funding || funding.mode !== "escrow" || !commissionStatus || !connected || busy) return;
    if (connectedAddress !== funding.payer_wallet) { setError("Reconnect the payer wallet authorized for this refund."); return; }
    setBusy(true);
    setError("");
    try {
      const sent = await sendRealizeEscrowRefund({wallet: connected.wallet, account: connected.account, supportedTransactionVersions: connected.supportedTransactionVersions, payerAddress: connected.account.address, commission: commissionStatus.commission, quote, issuerPublicKey: quote.issuer_public_key, funding, cluster: networkName, onSubmitted: (_signature, url) => setTransactionUrl(url)});
      if (sent.confirmation === "failed") throw new Error("The refund transaction failed on Solana. Refresh escrow status before trying again.");
      if (sent.confirmation === "pending") {
        setPendingRefundSignature(sent.signature);
        const saved = loadSavedCheckout(post.post_id, commissionId);
        if (saved) saveCheckout({...saved, refundTransactionSignature: sent.signature, transactionUrl: sent.explorerUrl});
        setError("The refund transaction was submitted, but confirmation is delayed. Check its status before continuing.");
        return;
      }
      await submitRefund(sent.signature);
    } catch (reason) { setError(walletRejected(reason) ? "Refund canceled in your wallet. Your escrow remains unchanged." : checkoutError(reason)); }
    finally { setBusy(false); }
  }

  const state = commissionStatus?.commission.state;
  const refundReady = state === "REFUND_PENDING" && funding?.mode === "escrow" && funding.progress?.status === "Refundable";
  const commissionState = state;
  const isTerminal = commissionState === "SETTLED" || commissionState === "REFUNDED" || commissionState === "EXPIRED";
  const output = commissionStatus?.fulfillment_result?.outputs[0];
  const capabilitiesReady = !capabilityLoading && !capabilityError && !!selectedCapability && !!options;
  const publicCommissionerParty = rights?.policy_mode === "first_party" ? true : !!rights && rights.agreement.parties.some((party) => party.party_id === REALIZE_COMMISSIONER_ROLE_PARTY_ID && party.role === "commissioner");

  return <div className="drawer-backdrop" onClick={() => { if (!busy) onClose(); }}><aside className="drawer realize realize-checkout" role="dialog" aria-modal="true" aria-label="Realize commission checkout" onClick={(event) => event.stopPropagation()}>
    <button className="icon-button close" onClick={onClose} disabled={busy} aria-label="Close realization">×</button>
    <p className="eyebrow">✦ Realize</p>
    <h2>Bring your idea to life.</h2>
    <p className="muted">{selectedCreator ? "Create a custom video with " + selectedCreator.registration.display_name + "." : "Create a custom video from your idea."}</p>
    {error && <div className="error-box" role="alert">{error}</div>}
    {identityLoading && <div className="loading-line">Getting your checkout ready…</div>}

    <section className="checkout-section" aria-label="Choose a creator">
      <label className="field-label" htmlFor="realize-creator">Create with</label>
      <select id="realize-creator" className="realize-field" value={creatorId} onChange={(event) => { if (testVideoMode) setIntegrationTestCheckout(false); setCreatorId(event.target.value); invalidateQuote(); setError(""); }} disabled={paymentPending || (!!commissionStatus?.commission.accepted_quote_hash && !quoteExpired) || busy}>
        {creatorOptions.length === 0 && <option value="">No creators are available</option>}
        {creatorOptions.map((agent) => <option key={agent.registration.agent_id} value={agent.registration.agent_id}>{agent.registration.display_name} · @{agent.registration.handle.replace(/^.*@/, "")}</option>)}
      </select>
      {import.meta.env.DEV && testVideoCapabilityAvailable && <button type="button" className="secondary-button" onClick={() => setIntegrationTestCheckout(!testVideoMode)} disabled={restoringCommission || busy || paymentPending || quoteAccepted && !quoteExpired}>{testVideoMode ? "Return to custom video checkout" : "Use prerecorded payment-path test"}</button>}
      {capabilityError && <div className="error-box" role="alert">{capabilityError}<button type="button" className="secondary-button" onClick={() => setCapabilityAttempt((attempt) => attempt + 1)}>Retry creator setup</button></div>}
    </section>

    <section className="checkout-section" aria-label="Describe your video">
      {testVideoMode ? <div className="test-video-summary" role="note" aria-label="Prerecorded payment-path test"><strong>Prerecorded checkout demo</strong><span>This uses Populi’s bundled five-second Bob clip. It checks the payment and delivery path; it does not generate a clip from a custom prompt.</span><span>“{REALIZE_TEST_VIDEO_REQUEST.concept}” · 5 seconds · 480P</span></div> : <>
        <label className="field-label" htmlFor="realize-description">Your idea</label>
        <textarea id="realize-description" className="realize-field realize-description" aria-describedby="realize-description-hint" rows={4} maxLength={options?.maxDescriptionLength ?? 2_000} placeholder="For example: A quiet cabin in the woods at sunrise, warm light through the windows…" value={description} onChange={(event) => { setDescription(event.target.value); invalidateQuote(); }} disabled={paymentPending || (!!commissionStatus?.commission.accepted_quote_hash && !quoteExpired) || busy} />
        <div className="field-footnote"><span id="realize-description-hint">A sentence is enough to start.</span>{description.length > (options?.maxDescriptionLength ?? 2_000) - 120 && <span>{description.length}/{options?.maxDescriptionLength ?? 2_000}</span>}</div>
        {options && <div className="realize-options">
          {options.supportsStyle && <label className="field-control">Style<select className="realize-field" value={style} onChange={(event) => { setStyle(event.target.value as RealizeStyle); invalidateQuote(); }} disabled={busy || paymentPending || (!!commissionStatus?.commission.accepted_quote_hash && !quoteExpired)}>{STYLE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>}
          <label className="field-control">Length<select className="realize-field" value={duration} onChange={(event) => { setDuration(Number(event.target.value)); invalidateQuote(); }} disabled={busy || paymentPending || (!!commissionStatus?.commission.accepted_quote_hash && !quoteExpired)}>{options.durations.map((value) => <option key={value} value={value}>{value} seconds</option>)}</select></label>
          {options.resolutions.length > 0 && <label className="field-control">Quality<select className="realize-field" value={resolution} onChange={(event) => { setResolution(event.target.value); invalidateQuote(); }} disabled={busy || paymentPending || (!!commissionStatus?.commission.accepted_quote_hash && !quoteExpired)}>{options.resolutions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
        </div>}
      </>}
      {quoteError && !quote && <p className="quote-inline-error" role="alert">{quoteError}</p>}
      <button type="button" className="primary-button wide quote-request-button" onClick={() => void requestQuote()} disabled={busy || restoringCommission || paymentPending || identityLoading || !identity || !capabilitiesReady || !rights || (!!commissionStatus?.commission.accepted_quote_hash && !quoteExpired)}>
        {busy && !quote ? "Getting your price…" : quote ? "Update my price" : testVideoMode ? "Get demo price" : "Get my price"}
      </button>
      <p className="quote-button-hint">Free quote · pay only when you approve.</p>
    </section>

    {quote && <section ref={quoteReviewRef} className="checkout-section quote-review" aria-label="Your price and checkout">
      <div className="quote-price-hero"><p className="eyebrow">Your price</p><div><strong>{money(quote.total_amount_usdc_atomic)}</strong><span>USDC total</span></div><p>One-time price · one custom video</p></div>
      <div className="quote-validity"><span>{quoteValid ? "✓ Price verified" : "Price could not be verified"}</span><span className={quoteExpired ? "quote-expired" : ""}>{quoteExpired ? "Price expired · update it to continue" : "Price expires in " + epochSeconds(quote.expires_at, now)}</span></div>
      <div className="quote-creation-summary"><strong>{selectedCreator?.registration.display_name ?? quote.creator_id}</strong><p>{generationDescription(quote.requested_generation_parameters) || description}</p></div>
      {!quoteMatches && <p className="quote-stale" role="status">The creator or video details changed. Get an updated price to continue.</p>}
      {!currentTermsMatchQuote && <p className="quote-stale" role="alert">This price does not match the active usage terms. Please get an updated quote.</p>}
      {quoteError && <p className="quote-inline-error" role="alert">{quoteError}</p>}
      <label className="consent-row quote-consent"><input type="checkbox" checked={rightsReviewed} onChange={(event) => setRightsReviewed(event.target.checked)} disabled={!currentTermsMatchQuote || !!commissionStatus?.commission.accepted_quote_hash} /><span>I agree to the usage terms and this price.</span></label>
      <label className="consent-row quote-consent"><input type="checkbox" checked={nftPublicationConsent} onChange={(event) => setNftPublicationConsent(event.target.checked)} disabled={!!commissionStatus?.commission.accepted_quote_hash} /><span>Publish my finished video as a public NFT.</span></label>
      <p className="tiny muted">If selected, anyone can view the video and NFT metadata. Your connected wallet is visible on-chain, including its payment and ownership history. Your generation prompt is not included in the NFT metadata.</p>
      <button type="button" className="fine-print-link" aria-expanded={finePrintOpen} aria-controls="realize-fine-print" onClick={() => setFinePrintOpen((open) => !open)}>{finePrintOpen ? "Hide the fine print" : "Read the fine print"}</button>
      <div id="realize-fine-print" className="checkout-fineprint checkout-fineprint-content" hidden={!finePrintOpen}>
          <section className="fine-print-section">
            <h4>Price breakdown</h4>
            <div className="price-breakdown" aria-label="USDC quote breakdown">
              <div><span>{quote.revenue_allocation_policy ? "Video generation (" + (quote.revenue_allocation_policy.provider_basis_points / 100).toFixed(2) + "%)" : "Generation"}</span><strong>{money(quote.provider_base_price_usdc_atomic)} USDC</strong></div>
              <div><span>{quote.revenue_allocation_policy ? "Creator (" + (quote.revenue_allocation_policy.character_owner_basis_points / 100).toFixed(2) + "%)" : "Creator fee"}</span><strong>{money(quote.character_owner_markup_usdc_atomic)} USDC</strong></div>
              <div><span>{quote.revenue_allocation_policy ? "VOX service fee (" + (quote.revenue_allocation_policy.platform_basis_points / 100).toFixed(2) + "%)" : "VOX service fee"}</span><strong>{money(quote.platform_fee_usdc_atomic)} USDC</strong></div>
              {(quote.additional_beneficiaries ?? []).map((item) => <div key={item.recipient_id + ":" + item.role}><span>{item.role.replaceAll("_", " ")}</span><strong>{money(item.amount_usdc_atomic)} USDC</strong></div>)}
              <div className="price-total"><span>Total</span><strong>{money(quote.total_amount_usdc_atomic)} USDC</strong></div>
            </div>
            {quote.revenue_allocation_policy && <p className="tiny muted">This quote is fixed for one video generation.</p>}
          </section>

          {quote.network_id && <p className="quote-network">Payment network: <strong>{quote.network_id.replace("solana:", "Solana ")}</strong> · USDC</p>}

          <section className="rights-summary-panel">
            <div className="rights-summary-heading"><div><p className="eyebrow">Usage terms</p><h4 id="realize-rights-heading">How you can use your video</h4></div></div>
            {rights?.policy_mode === "first_party" ? <p className="rights-price-note">{rights.policy.statement}</p> : rights ? <p className="rights-price-note">This price covers one generation. Use of the finished work and future revenue follow the creator’s agreement.</p> : <p className="tiny muted">Loading usage terms…</p>}
            {rights?.policy_mode === "first_party" && <div className="rights-agreement"><span>VOX policy</span><strong>{rights.policy.policy_id} · version {rights.policy.version}</strong><span>Creator</span><strong>{rights.policy.creator_id}</strong><code>{rights.terms_hash}</code></div>}
            {rights && rights.policy_mode !== "first_party" && <div className="rights-grid">
              <div><strong>Use of the generated work</strong><span>{rights.agreement.grant.work_scope}</span></div>
              <div><strong>Rights and territory</strong><span>{rights.agreement.grant.rights.join(", ")} · {rights.agreement.grant.license_type.replaceAll("_", " ")} · {rights.agreement.grant.territory.join(", ")}</span></div>
              <div><strong>Eligible future revenue</strong><span>{rights.agreement.revenue_definition.description} ({rights.agreement.revenue_definition.basis.replaceAll("_", " ")}).</span></div>
              <div><strong>Future revenue allocations</strong><span>{rights.agreement.allocations.map((item) => item.beneficiary_id + ": " + (item.basis_points / 100).toFixed(2) + "%").join(" · ")}</span></div>
              <div><strong>Revenue deductions</strong><span>{rights.agreement.revenue_definition.permitted_deductions.length ? rights.agreement.revenue_definition.permitted_deductions.map((item) => item.replaceAll("_", " ")).join(", ") : "None"}</span></div>
              <div><strong>Rights term</strong><span>{new Date(rights.agreement.duration.starts_at).toLocaleDateString()} – {rights.agreement.duration.ends_at ? new Date(rights.agreement.duration.ends_at).toLocaleDateString() : "No end date stated"}</span></div>
              <div><strong>Work attribution</strong><span>{rights.agreement.grant.attribution_required ? "Required by this agreement" : "Not required by this agreement"}</span></div>
            </div>}
            {rights && rights.policy_mode !== "first_party" && <div className="rights-agreement"><span>Rights agreement</span><strong>{rights.agreement.agreement_id} · version {rights.agreement.version}</strong><code>{rights.terms_hash}</code><span>Eligible transactions</span><strong>{rights.agreement.eligible_transaction_types.join(", ")}</strong></div>}
            {rights && rights.policy_mode !== "first_party" && !publicCommissionerParty && !rights.agreement.parties.some((party) => party.party_id === identity?.humanId && party.role === "commissioner") && <p className="tiny muted">This agreement is not configured for private checkout.</p>}
          </section>

          {quoteAccepted && funding && <div className="payment-authority-note"><span>{funding.mode === "escrow" ? "VOX-authorized Devnet escrow" : "Mainnet treasury · backend-managed"}</span><code>{short(funding.mode === "escrow" ? funding.escrow : funding.destination_token_account)}</code><span>Exact amount</span><strong>{money(funding.amount_usdc_atomic)} USDC</strong>{funding.mode === "escrow" && funding.progress && <><span>On-chain setup</span><strong>{funding.progress.status.toLowerCase()} · {funding.progress.payout_count}/{funding.payouts.length} recipients</strong></>}{funding.mode === "direct" && <span className="tiny muted">VOX manages settlement and refunds after generation.</span>}</div>}

          <details className="terms-details public-credit-details"><summary>Public credit <span>optional</span></summary><label className="consent-row"><input type="checkbox" checked={publicConsent} onChange={(event) => setPublicConsent(event.target.checked)} disabled={!!commissionStatus?.commission.accepted_quote_hash} /><span>Include a public credit with the finished work.</span></label>{publicConsent && <label className="field-label" htmlFor="realize-attribution">Credit text<input id="realize-attribution" className="realize-field" maxLength={120} value={publicAttribution} onChange={(event) => setPublicAttribution(event.target.value)} placeholder="Name or credit to display publicly" disabled={!!commissionStatus?.commission.accepted_quote_hash} /></label>}<p className="tiny muted">Public credit is optional. Wallet and billing details stay private.</p></details>

          <div className="advanced-quote-details"><span>Signed quote <code>{short(quote.quote_id)}</code> · {quoteValid ? "verified" : "signature invalid"}</span><span>Quote expires {new Date(quote.expires_at).toLocaleString()}</span>{quote.network_id && <span>USDC mint <code>{short(quote.usdc_mint ?? "")}</code></span>}</div>
        </div>


      {!quoteAccepted && <div className="wallet-connect-panel quote-wallet-panel">
        <div className="wallet-network-line"><strong>{connected ? "Wallet connected" : "Pay with USDC"}</strong>{connected && <span className="wallet-address">{short(connected.account.address)}</span>}{!connected && (walletStatus === "pending" || walletStatus === "reconnecting") && <span className="tiny muted">Reconnecting…</span>}</div>
        {!connected && (wallets.length > 0 ? <div className="wallet-options">{wallets.map((wallet) => <button type="button" className="secondary-button" key={wallet.name} onClick={() => void connectWallet(wallet)}>Connect {wallet.name}</button>)}</div> : <p className="tiny muted">Connect a Solana wallet to pay with USDC.</p>)}
      </div>}
      {networkMismatch && <p className="network-warning" role="alert">This quote requires Solana {networkName}, but this checkout is configured for {configuredWalletCluster()}.</p>}
      {walletChainMismatch && <p className="network-warning" role="alert">Switch your connected wallet to Solana {networkName} to continue.</p>}
      {payerWalletMismatch && <p className="network-warning" role="alert">Reconnect the payer wallet for this quote: <code>{funding?.payer_wallet}</code>.</p>}
      {mainnetRealizeDisabled && <p className="network-warning" role="alert">Mainnet checkout is not available in this web build.</p>}
      {quoteAccepted && <div className="checkout-status-grid"><div><span>Payment</span><strong>{paymentLabel(commissionStatus?.commission.payment_state, !!pendingSignature || !!pendingPaymentAttempt, paymentProgress)}</strong></div><div><span>Generation</span><strong>{generationLabel(commissionStatus?.commission.fulfillment_state)}</strong></div><div><span>Settlement</span><strong>{commissionStatus?.settlement_status ?? "Not started"}</strong></div></div>}
      {quoteAccepted && funding && <div className="payer-wallet-summary" aria-label="Payer wallet"><span>Paying from</span><code title={funding.payer_wallet}>{funding.payer_wallet}</code></div>}
      {!quoteAccepted && <button type="button" className="primary-button wide" onClick={() => void acceptQuote()} disabled={!canAcceptQuote || !attributionReady}>{busy ? "Preparing checkout…" : !connected ? "Connect a wallet to continue" : !rightsReviewed ? "Accept terms to continue" : "Continue to payment"}</button>}
      {!quoteAccepted && <p className="quote-button-hint">You’ll confirm the amount in your wallet.</p>}
      {quoteAccepted && !paymentIsVerified && !pendingSignature && !pendingPaymentAttempt && <button type="button" className="primary-button wide" onClick={() => void pay()} disabled={busy || !connected || !funding || quoteExpired || !quoteValid || mainnetRealizeDisabled || networkMismatch || walletChainMismatch || payerWalletMismatch}>{busy ? paymentProgress === "wallet_approval" ? "Approve payment in your wallet…" : paymentProgress === "vox_verification" ? "Checking payment with VOX.gold…" : "Checking balance and preparing payment…" : `Pay ${money(quote.total_amount_usdc_atomic)} USDC`}</button>}
      {quoteAccepted && pendingSignature && pendingPaymentAttempt?.kind !== "wallet_submission" && !paymentIsVerified && <div className="pending-payment" role="status"><strong>{paymentProgress === "solana_confirmation" ? "Payment submitted; waiting for Solana confirmation." : "Payment submitted; VOX.gold verification is pending."}</strong><span>{paymentProgress === "solana_confirmation" ? "The signed transaction is saved. Check its status to retry the same transaction safely; do not pay twice." : `Do not pay twice. VOX.gold checks the ${funding?.mode === "escrow" ? "escrow commitment" : "Mainnet payment intent"}, USDC mint, recipient, amount, payer and finalized transaction on-chain.`}</span><button type="button" className="secondary-button" onClick={() => void checkPayment()} disabled={busy}>{busy ? "Checking…" : "Check payment status"}</button></div>}
      {quoteAccepted && pendingPaymentAttempt?.kind === "wallet_submission" && !paymentIsVerified && !busy && <div className="pending-payment" role="status"><strong>Payment outcome needs checking.</strong><span>Your wallet may have sent the payment before its response was lost. Do not pay again. Find this payment in your wallet history and copy its transaction signature.</span><label className="field-label">Transaction signature from your wallet<input className="realize-field" value={walletReceipt} onChange={(event) => setWalletReceipt(event.target.value)} autoComplete="off" spellCheck={false} /></label><button type="button" className="secondary-button" onClick={() => void verifyWalletReceipt()} disabled={busy || !walletReceipt.trim()}>Verify wallet receipt</button><button type="button" className="secondary-button" onClick={() => void checkPayment()} disabled={busy}>Check payment status</button></div>}
      {pendingRefundSignature && commissionStatus?.commission.payment_state === "refund_pending" && <div className="pending-payment" role="status"><strong>Refund submitted; Devnet confirmation is pending.</strong><span>VOX.gold verifies the finalized refund instruction and the payer ATA settlement before changing this status.</span><button type="button" className="secondary-button" onClick={() => void checkPayment()} disabled={busy}>{busy ? "Checking…" : "Check refund status"}</button></div>}
      {refundReady && !pendingRefundSignature && connectedAddress === funding?.payer_wallet && <button type="button" className="primary-button wide" onClick={() => void claimRefund()} disabled={busy}>{busy ? "Waiting for wallet and refund verification…" : `Claim ${money(funding?.amount_usdc_atomic)} USDC refund`}</button>}
      {refundReady && !connected && <p className="tiny muted">Reconnect the payer wallet to claim this escrow refund.</p>}
      {refundReady && connected && connectedAddress !== funding?.payer_wallet && <p className="network-warning" role="alert">Connect the same wallet that funded this commission to claim its refund.</p>}
      {quoteAccepted && !connected && !paymentIsVerified && <p className="tiny muted">Reconnect the payer wallet to fund this accepted quote.</p>}
      {transactionUrl && <p className="tiny"><a href={transactionUrl} target="_blank" rel="noreferrer">View transaction on Solana ↗</a></p>}
    </section>}

    {commissionStatus && quoteAccepted && <section className="checkout-section realization-tracking" aria-labelledby="realize-tracking-heading">
      <div className="checkout-section-heading"><span>05</span><div><p className="eyebrow">Commission tracking</p><h3 id="realize-tracking-heading">{commissionTrackingLabel(commissionStatus, !!pendingSignature || !!pendingPaymentAttempt)}</h3></div></div>
      <div className="checkout-status-grid tracking-statuses"><div><span>Payment</span><strong>{paymentLabel(commissionStatus.commission.payment_state, !!pendingSignature || !!pendingPaymentAttempt, paymentProgress)}</strong></div><div><span>Generation</span><strong>{generationLabel(commissionStatus.commission.fulfillment_state)}</strong></div><div><span>Settlement</span><strong>{commissionStatus.settlement_status.replaceAll("_", " ")}</strong></div></div>
      {trackingError && <p className="tiny muted" role="status">Status refresh delayed: {trackingError}. Reopen this checkout to continue tracking.</p>}
      {isGenerationInProgress(commissionStatus) && <div className="generation-progress"><span className="spinner" /><div><strong>{commissionStatus.commission.fulfillment_state === "queued" ? "In the generation queue" : "The creator is generating your work"}</strong><span>This commission refreshes automatically.</span></div></div>}
      {commissionStatus.failure_reason && <p className="error-box">{commissionStatus.failure_reason}</p>}
      {output?.uri && <div className="artifact-card"><p className="eyebrow">Completed artifact</p>{output.media_type.startsWith("video/") ? <video className="commission-artifact" controls playsInline preload="metadata" aria-label="Completed commissioned creation"><source src={output.uri} type={output.media_type} /></video> : output.media_type.startsWith("image/") ? <img className="commission-artifact" src={output.uri} alt="Completed commissioned creation" /> : <a href={output.uri} target="_blank" rel="noreferrer">Open completed artifact ↗</a>}{output.page_url && <a className="secondary-button" href={output.page_url} target="_blank" rel="noreferrer">View and share on Populi ↗</a>}<code>{output.sha256}</code></div>}
      {provenance && <div className="provenance-status"><span>✓</span><div><strong>Signed provenance verified</strong><code>{provenance.provenance_record_id}</code><code>{provenance.outputs.map((item) => item.sha256).join(", ")}</code>{provenance.public_attribution && <span>Public credit: {provenance.public_attribution}</span>}</div></div>}
      <RealizeNfts mediaIds={commissionStatus.nft_media_ids ?? []} identity={identity} />
      {commissionStatus.settlement_response?.transaction_signatures?.map((signature) => <p className="tiny" key={signature}><a href={`https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=${encodeURIComponent(networkName)}`} target="_blank" rel="noreferrer">View verified settlement transaction ↗</a></p>)}
      <p className="tiny muted">Commission ID {short(commissionStatus.commission.commission_id)} · Public provenance contains no payer wallet or billing details.</p>
    </section>}
  </aside></div>;
}
