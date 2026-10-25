import {execFileSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {readFileSync} from "node:fs";
import {generateKeyPair, secretKeyBase64} from "@vox/protocol";

const settings = JSON.parse(readFileSync(new URL("../deployments/realize-staging.json", import.meta.url), "utf8"));
if (settings.environment !== "staging" || settings.projectId === "voxprotocol" || settings.network !== "solana:devnet" || settings.mainnetEnabled !== false) throw new Error("Staging target must be isolated from production and use Devnet only");
const image = process.argv.find((value) => value.startsWith("--image="))?.slice(8);
if (!process.argv.includes("--apply") || !image?.startsWith(`us-east1-docker.pkg.dev/${settings.projectId}/cruelty/vox-realize-staging:`)) throw new Error("Use --apply --image=<the reviewed VOX staging image>");
const projectFlag = `--project=${settings.projectId}`;
const regionFlag = `--region=${settings.region}`;
const serviceAccountName = "vox-realize-stage";
const serviceAccount = `${serviceAccountName}@${settings.projectId}.iam.gserviceaccount.com`;
function gcloud(args: string[], input?: string | Buffer): string {
  for (let attempt = 0; ; attempt += 1) {
    try { return execFileSync("gcloud", [...args, projectFlag, "--quiet"], {encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"]}); }
    catch (error) {
      if (attempt >= 3 || !/concurrent policy changes|ETag|ABORTED/i.test(String((error as {stderr?: string}).stderr))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * 2 ** attempt);
    }
  }
}
function json(args: string[]): any { return JSON.parse(gcloud([...args, "--format=json"])); }
const secrets = new Set(json(["secrets", "list"]).map((secret: {name: string}) => secret.name.split("/").at(-1)));
function secret(name: string, content: () => string | Buffer): void {
  if (!secrets.has(name)) {
    gcloud(["secrets", "create", name, "--replication-policy=automatic"]);
    secrets.add(name);
  }
  const versions = json(["secrets", "versions", "list", name, "--filter=state=ENABLED", "--limit=1"]);
  if (!versions.length) gcloud(["secrets", "versions", "add", name, "--data-file=-"], content());
}
const accounts = json(["iam", "service-accounts", "list"]);
if (!accounts.some((account: {email: string}) => account.email === serviceAccount)) gcloud(["iam", "service-accounts", "create", serviceAccountName, "--display-name=VOX Realize staging only"]);
const databases = json(["firestore", "databases", "list"]);
if (!databases.some((database: {name: string}) => database.name.endsWith(`/${settings.firestoreDatabase}`))) gcloud(["firestore", "databases", "create", `--database=${settings.firestoreDatabase}`, `--location=${settings.region}`, "--type=firestore-native", "--delete-protection"]);
gcloud(["projects", "add-iam-policy-binding", settings.projectId, `--member=serviceAccount:${serviceAccount}`, "--role=roles/datastore.user", "--condition=None"]);
const buckets = json(["storage", "buckets", "list"]);
if (!buckets.some((bucket: {name: string}) => bucket.name === settings.avatarBucket)) gcloud(["storage", "buckets", "create", `gs://${settings.avatarBucket}`, `--location=${settings.region}`, "--uniform-bucket-level-access", "--public-access-prevention"]);
gcloud(["storage", "buckets", "add-iam-policy-binding", `gs://${settings.avatarBucket}`, `--member=serviceAccount:${serviceAccount}`, "--role=roles/storage.objectUser"]);
secret("vox-realize-staging-instance-key", () => secretKeyBase64(generateKeyPair().secretKey));
secret("vox-realize-staging-internal-token", () => randomBytes(32).toString("base64url"));
for (const [name, file] of [["quote-authority", "quote-authority.json"], ["fulfillment-authority", "fulfillment-authority.json"], ["fee-payer", "fee-payer.json"]]) {
  secret(`vox-realize-staging-devnet-${name}`, () => readFileSync(new URL(`../.vox-local/realize-devnet/${file}`, import.meta.url)));
}
const clients = JSON.parse(gcloud(["secrets", "versions", "access", "latest", `--secret=${settings.populiClientsSecret}`]));
let client = clients.find((item: {verifier_ids: string[]}) => item.verifier_ids.includes(settings.voxInstanceId));
if (!client) {
  client = {id: "vox-realize-staging", token: randomBytes(32).toString("base64url"), scopes: ["capabilities:read", "provider-prices:create", "fulfillments:create", "fulfillments:read", "funding:assert"], verifier_ids: [settings.voxInstanceId]};
  clients.push(client);
  gcloud(["secrets", "versions", "add", settings.populiClientsSecret, "--data-file=-"], JSON.stringify(clients));
}
secret("vox-realize-staging-populi-token", () => client.token);
let stagingOperatorHumanId: string | undefined;
try {
  const stagingFixtures = JSON.parse(gcloud(["secrets", "versions", "access", "latest", "--secret=vox-realize-staging-fixture-identities"]));
  // Keep the staging refund operator distinct from the commissioning customer.
  if (typeof stagingFixtures.owner?.registration?.human_id === "string") stagingOperatorHumanId = stagingFixtures.owner.registration.human_id;
} catch { /* Existing installations can bootstrap identities after the first deploy. */ }
const requiredSecrets = ["vox-realize-staging-instance-key", "vox-realize-staging-internal-token", "vox-realize-staging-populi-token", settings.populiWebhookSecret, "vox-realize-staging-devnet-quote-authority", "vox-realize-staging-devnet-fulfillment-authority", "vox-realize-staging-devnet-fee-payer"];
for (const name of requiredSecrets) gcloud(["secrets", "add-iam-policy-binding", name, `--member=serviceAccount:${serviceAccount}`, "--role=roles/secretmanager.secretAccessor"]);
const indexes = JSON.parse(readFileSync(new URL("../infrastructure/gcp/firestore.indexes.json", import.meta.url), "utf8")).indexes;
const existingIndexes = json(["firestore", "indexes", "composite", "list", `--database=${settings.firestoreDatabase}`]);
for (const index of indexes) {
  const matches = existingIndexes.some((actual: any) => actual.name.includes(`/collectionGroups/${index.collectionGroup}/`) && index.fields.every((field: any) => actual.fields.some((candidate: any) => candidate.fieldPath === field.fieldPath && (field.arrayConfig ? candidate.arrayConfig === field.arrayConfig : candidate.order === field.order))));
  if (!matches) gcloud(["firestore", "indexes", "composite", "create", "--async", `--database=${settings.firestoreDatabase}`, `--collection-group=${index.collectionGroup}`, ...index.fields.map((field: any) => `--field-config=field-path=${field.fieldPath},${field.order ? `order=${field.order.toLowerCase()}` : `array-config=${field.arrayConfig.toLowerCase()}`}`)]);
}
const env = {
  GOOGLE_CLOUD_PROJECT: settings.projectId, VOX_STORAGE: "firestore", VOX_FIRESTORE_DATABASE: settings.firestoreDatabase,
  VOX_AVATAR_BUCKET: settings.avatarBucket,
  VOX_INSTANCE_ID: settings.voxInstanceId, VOX_ANCHOR_MODE: "disabled", VOX_PAYMENT_MODE: "mock", VOX_SOLANA_CLUSTER: "devnet",
  ...(stagingOperatorHumanId ? {VOX_REALIZE_STAGING_FAILURE_REHEARSAL_ENABLED: "true", VOX_REALIZE_OPERATOR_HUMAN_IDS: stagingOperatorHumanId} : {}),
  VOX_REALIZE_DEVNET_ENABLED: "true", VOX_REALIZE_MAINNET_ENABLED: "false", VOX_REALIZE_DEVNET_RPC_URL: "https://api.devnet.solana.com",
  VOX_REALIZE_DEVNET_PROGRAM_ID: "GHLw1HY5BMXRUNzxeMVsv5r7usjQKWJA9SGVMGzNi3tb", VOX_REALIZE_DEVNET_USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  VOX_REALIZE_DEVNET_ADMIN: "4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL", VOX_REALIZE_DEVNET_QUOTE_AUTHORITY: "6yj1txeBEHJX5RULpRHExRCXe4x2p8ZeWYgc5y353im4",
  VOX_REALIZE_DEVNET_FULFILLMENT_AUTHORITY: "8RiNuRwnJydiZq9tuAVBZWKw77UA7qovNMySJQS3AcE9",
  VOX_REALIZE_DEVNET_QUOTE_AUTHORITY_KEYPAIR_PATH: "/run/secrets/vox-realize-devnet/quote/authority.json",
  VOX_REALIZE_DEVNET_FULFILLMENT_AUTHORITY_KEYPAIR_PATH: "/run/secrets/vox-realize-devnet/fulfillment/authority.json",
  VOX_REALIZE_DEVNET_FEE_PAYER_KEYPAIR_PATH: "/run/secrets/vox-realize-devnet/payer/keypair.json"
};
const mounts = {VOX_INSTANCE_SECRET_KEY: "vox-realize-staging-instance-key:latest", VOX_INTERNAL_TOKEN: "vox-realize-staging-internal-token:latest", VOX_POPULI_API_TOKEN: "vox-realize-staging-populi-token:latest", VOX_REALIZE_POPULI_WEBHOOK_SECRET: `${settings.populiWebhookSecret}:latest`, "/run/secrets/vox-realize-devnet/quote/authority.json": "vox-realize-staging-devnet-quote-authority:latest", "/run/secrets/vox-realize-devnet/fulfillment/authority.json": "vox-realize-staging-devnet-fulfillment-authority:latest", "/run/secrets/vox-realize-devnet/payer/keypair.json": "vox-realize-staging-devnet-fee-payer:latest"};
gcloud(["run", "deploy", settings.voxService, regionFlag, `--image=${image}`, `--service-account=${serviceAccount}`, "--port=8080", "--min-instances=0", "--max-instances=1", "--concurrency=10", "--cpu=1", "--memory=512Mi", "--timeout=300", "--allow-unauthenticated", `--set-env-vars=${Object.entries(env).map(([name, value]) => `${name}=${value}`).join(",")}`, `--set-secrets=${Object.entries(mounts).map(([name, value]) => `${name}=${value}`).join(",")}`]);
const origin = json(["run", "services", "describe", settings.voxService, regionFlag]).status.url;
gcloud(["run", "services", "update", settings.voxService, regionFlag, `--update-env-vars=VOX_PUBLIC_BASE_URL=${origin},VOX_CORS_ORIGIN=${origin}`]);
// Refresh only provider staging revisions, preserving all other runtime settings.
for (const name of [settings.populiService, settings.populiWorkerService]) {
  const service = json(["run", "services", "describe", name, regionFlag]);
  const oldOrigins = service.spec.template.spec.containers[0].env.find((entry: any) => entry.name === "POPULI_REALIZE_CALLBACK_ORIGINS")?.value?.split(",") ?? [];
  const callbackOrigins = [...new Set([...oldOrigins, origin])].join(",");
  gcloud(["run", "services", "update", name, regionFlag, `--update-env-vars=^|^POPULI_REALIZE_CALLBACK_ORIGINS=${callbackOrigins}`, `--update-secrets=POPULI_REALIZE_CLIENTS=${settings.populiClientsSecret}:latest`]);
}
console.log(JSON.stringify({origin, service: settings.voxService, instanceId: settings.voxInstanceId, firestoreDatabase: settings.firestoreDatabase, providerClientId: client.id, network: settings.network, note: "Staging deployed. No payer transaction or generation submitted; creator rights/payout bootstrap and payment rehearsal are separate."}, null, 2));
