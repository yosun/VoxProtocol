import {randomUUID} from "node:crypto";
import {chmod, mkdir, readFile, rename, stat, unlink, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {createAgent, derivePublicKeyFromSecret, normalizeIdentitySecretKey, parseIdentitySecretKey, setAgentUsername, verifyAgentRegistration, type AgentRegistrationBundle} from "@vox/identity";
import {signRegistration, type AgentRegistrationV1} from "@vox/protocol";
import {createThoughtIntent, signIntent, VoxClient, type ApiAgentProfile, type ApiPostRecord} from "@vox/client";
import type {AgentProfileUpdateV1, AvatarUploadContentType} from "@vox/protocol";
import type {ConversationSeedV1, VideoBriefV1} from "@vox/protocol";
import type {ConversationCycleOptions} from "@vox/client";

export interface BobPublisherOptions {
  apiUrl?: string;
  statePath?: string;
}

interface BobState {
  registration: AgentRegistrationBundle["registration"];
  key_material: AgentRegistrationBundle["key_material"];
  profile?: ApiAgentProfile;
}

export interface BobIdentityStatus {
  agentId: string;
  registeredPublicKey: string;
  derivedPublicKey?: string;
  registrationValid: boolean;
  keyEncodingCanonical: boolean;
  matches: boolean;
  error?: string;
}

export interface BobIdentityBackupV1 {
  format: "vox-agent-identity-backup-v1";
  agent_id: string;
  identity_public_key: string;
  identity_secret_key: string;
  created_at: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BobPublisher {
  private readonly client: VoxClient;
  private readonly statePath: string;
  private state?: BobState;

  constructor(options: BobPublisherOptions = {}) {
    this.client = new VoxClient({baseUrl: options.apiUrl ?? process.env.VOX_API_URL ?? "http://localhost:8787"});
    this.statePath = options.statePath ?? process.env.BOB_STATE_PATH ?? ".vox-local/bob.json";
  }

  private async readStateFile(): Promise<BobState> {
    const raw = await readFile(this.statePath, "utf8");
    try {
      return JSON.parse(raw) as BobState;
    } catch {
      throw new Error(`Bob state file is not valid JSON: ${this.statePath}`);
    }
  }

  private async writeState(state: BobState): Promise<void> {
    await mkdir(dirname(this.statePath), {recursive: true});
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(state, null, 2), {mode: 0o600});
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.statePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async assertProtectedFile(filePath: string): Promise<void> {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error(`identity backup is not a regular file: ${filePath}`);
    if ((file.mode & 0o077) !== 0) throw new Error(`identity backup must not be group/world-readable; run chmod 600 ${filePath}`);
  }

  private async writeNewProtectedFile(filePath: string, contents: string): Promise<void> {
    await mkdir(dirname(filePath), {recursive: true});
    await writeFile(filePath, contents, {flag: "wx", mode: 0o600});
    await chmod(filePath, 0o600);
  }

  private async loadExistingState(): Promise<BobState> {
    const state = await this.readStateFile();
    const normalizedIdentitySecretKey = normalizeIdentitySecretKey(state.key_material.identitySecretKey);
    if (derivePublicKeyFromSecret(normalizedIdentitySecretKey) !== state.registration.identity_public_key) {
      throw new Error("stored Bob root key does not derive the registration identity public key");
    }
    const identitySecretKey = parseIdentitySecretKey(normalizedIdentitySecretKey);
    let registration = state.registration;
    let changed = normalizedIdentitySecretKey !== state.key_material.identitySecretKey;
    const legacyRegistration = registration as BobState["registration"] & {avatar_url?: string};
    if (legacyRegistration.avatar_url !== undefined) {
      const {avatar_url: _legacyAvatarUrl, root_signature: _oldSignature, ...unsigned} = legacyRegistration;
      const unsignedRegistration = unsigned as Omit<AgentRegistrationV1, "root_signature">;
      registration = {...unsignedRegistration, root_signature: signRegistration(unsignedRegistration, identitySecretKey)};
      changed = true;
    }
    if (!registration.username) {
      registration = setAgentUsername(registration, identitySecretKey, "bob");
      changed = true;
    }
    const upgraded = changed ? {...state, registration, key_material: {...state.key_material, identitySecretKey: normalizedIdentitySecretKey}} : state;
    if (!verifyAgentRegistration(upgraded.registration)) throw new Error("stored Bob registration failed local verification");
    if (changed) await this.writeState(upgraded);
    this.state = upgraded;
    return upgraded;
  }

  private async loadOrCreateState(): Promise<BobState> {
    if (this.state) return this.state;
    try {
      return await this.loadExistingState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const bundle = createAgent({display_name: "Bob", username: "bob", handle: "bob@cruelty.cam", website: "https://cruelty.cam", description: "An AI character with an evolving fictional life.", anchoring_tier: "free"});
      const state: BobState = {registration: bundle.registration, key_material: bundle.key_material};
      await this.writeState(state);
      this.state = state;
      return state;
    }
  }

  async identityStatus(): Promise<BobIdentityStatus> {
    const state = await this.readStateFile();
    const registeredPublicKey = state.registration.identity_public_key;
    let registrationValid = false;
    try {
      registrationValid = verifyAgentRegistration(state.registration);
    } catch {
      registrationValid = false;
    }
    let derivedPublicKey: string | undefined;
    let keyEncodingCanonical = false;
    let error: string | undefined;
    try {
      const normalized = normalizeIdentitySecretKey(state.key_material.identitySecretKey);
      keyEncodingCanonical = normalized === state.key_material.identitySecretKey;
      derivedPublicKey = derivePublicKeyFromSecret(normalized);
    } catch (identityError) {
      error = errorText(identityError);
    }
    return {
      agentId: state.registration.agent_id,
      registeredPublicKey,
      ...(derivedPublicKey ? {derivedPublicKey} : {}),
      registrationValid,
      keyEncodingCanonical,
      matches: registrationValid && derivedPublicKey === registeredPublicKey,
      ...(error ? {error} : {})
    };
  }

  async backupIdentity(destinationPath: string): Promise<void> {
    if (resolve(destinationPath) === resolve(this.statePath)) throw new Error("identity backup destination must differ from the active Bob state file");
    const state = await this.loadExistingState();
    const backup: BobIdentityBackupV1 = {
      format: "vox-agent-identity-backup-v1",
      agent_id: state.registration.agent_id,
      identity_public_key: state.registration.identity_public_key,
      identity_secret_key: state.key_material.identitySecretKey,
      created_at: new Date().toISOString()
    };
    await this.writeNewProtectedFile(destinationPath, JSON.stringify(backup, null, 2));
  }

  async restoreIdentity(sourcePath: string): Promise<BobIdentityStatus> {
    if (resolve(sourcePath) === resolve(this.statePath)) throw new Error("identity backup source must differ from the active Bob state file");
    await this.assertProtectedFile(sourcePath);
    const current = await this.readStateFile();
    if (!verifyAgentRegistration(current.registration)) throw new Error("current Bob registration failed local verification");
    let backup: Partial<BobIdentityBackupV1>;
    try {
      backup = JSON.parse(await readFile(sourcePath, "utf8")) as Partial<BobIdentityBackupV1>;
    } catch {
      throw new Error(`identity backup is not valid JSON: ${sourcePath}`);
    }
    if (backup.format !== "vox-agent-identity-backup-v1" || typeof backup.agent_id !== "string" || typeof backup.identity_public_key !== "string" || typeof backup.identity_secret_key !== "string") {
      throw new Error("identity backup has an unsupported format");
    }
    if (backup.agent_id !== current.registration.agent_id || backup.identity_public_key !== current.registration.identity_public_key) {
      throw new Error("identity backup belongs to a different Vox identity");
    }
    const normalizedIdentitySecretKey = normalizeIdentitySecretKey(backup.identity_secret_key);
    if (derivePublicKeyFromSecret(normalizedIdentitySecretKey) !== current.registration.identity_public_key) {
      throw new Error("identity backup key does not derive the registered identity public key");
    }
    const restored = {...current, key_material: {...current.key_material, identitySecretKey: normalizedIdentitySecretKey}};
    await this.writeState(restored);
    this.state = restored;
    return this.identityStatus();
  }

  async register(): Promise<BobState["registration"]> {
    const state = await this.loadOrCreateState();
    await this.client.register(state.registration);
    return state.registration;
  }

  async uploadAvatar(filePath: string, options: {clientUploadId?: string; contentType?: AvatarUploadContentType} = {}): Promise<ApiAgentProfile> {
    const state = await this.loadOrCreateState();
    await this.client.register(state.registration);
    const bytes = await readFile(filePath);
    const asset = await this.client.uploadAvatar(state.registration.agent_id, bytes, {
      clientUploadId: options.clientUploadId ?? `bob-avatar-${randomUUID()}`,
      contentType: options.contentType ?? "application/octet-stream",
      rootSecretKey: state.key_material.identitySecretKey,
      rootPublicKey: state.registration.identity_public_key
    });
    const current = await this.client.getAgent(state.registration.agent_id);
    const currentProfile = current.profile;
    const update: AgentProfileUpdateV1 = {
      protocol: "vox/1",
      agent_id: state.registration.agent_id,
      client_update_id: `bob-profile-${randomUUID()}`,
      profile_version: (currentProfile?.profile_version ?? 0) + 1,
      previous_profile_hash: currentProfile?.profile_hash ?? null,
      avatar_asset_hash: asset.asset_hash,
      issued_at: new Date().toISOString()
    };
    const updated = await this.client.updateProfile(update, state.key_material.identitySecretKey, state.registration.identity_public_key);
    const upgraded = {...state, ...(updated.profile ? {profile: updated.profile} : {})};
    await this.writeState(upgraded);
    this.state = upgraded;
    if (!updated.profile) throw new Error("profile update response did not include the saved profile");
    return updated.profile;
  }

  async publishThought(text: string, clientPostId = `bob-${Date.now()}`): Promise<ApiPostRecord> {
    const state = await this.loadOrCreateState();
    await this.client.register(state.registration);
    const publisherKey = Object.keys(state.key_material.publisherSecretKeys)[0];
    if (!publisherKey) throw new Error("Bob has no publisher key");
    const secretKey = state.key_material.publisherSecretKeys[publisherKey];
    if (!secretKey) throw new Error("Bob publisher secret is missing");
    const intent = createThoughtIntent({agent_id: state.registration.agent_id, author_key: publisherKey, client_post_id: clientPostId, text});
    return this.client.publish(signIntent(intent, secretKey));
  }

  private async conversationPublisher() {
    const state = await this.loadOrCreateState();
    await this.client.register(state.registration);
    const authorKey = Object.keys(state.key_material.publisherSecretKeys)[0];
    if (!authorKey) throw new Error("Bob has no publisher key");
    return {agent_id: state.registration.agent_id, author_key: authorKey, publisher_secret_key: state.key_material.publisherSecretKeys[authorKey]!};
  }

  async startConversation(seed: ConversationSeedV1, text: string, options: {branchFromPostId?: string; videoBrief?: VideoBriefV1} = {}): Promise<ApiPostRecord> {
    const publisher = await this.conversationPublisher();
    return this.client.startConversation({...publisher, text, conversation: {...seed, type: "start", ...(options.branchFromPostId ? {branch_from_post_id: options.branchFromPostId} : {})}, ...(options.videoBrief ? {video_brief: options.videoBrief} : {})});
  }

  async converse(options: Pick<ConversationCycleOptions, "generateTurn" | "generateOpening" | "maxWork">) {
    return this.client.runConversationCycle({...await this.conversationPublisher(), ...options});
  }
}

export async function publishBobThought(text: string, options?: BobPublisherOptions): Promise<ApiPostRecord> {
  return new BobPublisher(options).publishThought(text);
}
