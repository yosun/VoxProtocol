import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {HttpPopuliRealizeClient, type RealizeCreatorPayoutConfigurationV1} from "../apps/api/src/realize-engine.js";
import {videoOptions} from "../apps/web/src/realize-parameters.js";
import {assertStagingDeployment, assertStagingRevision, selectStagingProviderClient, servingStagingRevisions} from "./realize-staging-preflight.mjs";

const deployment = JSON.parse(readFileSync(new URL("../deployments/realize-staging.json", import.meta.url), "utf8"));
assertStagingDeployment(deployment);
function cloudJson(args: string[]) {
  return JSON.parse(execFileSync("gcloud", [...args, `--project=${deployment.projectId}`, `--region=${deployment.region}`, "--format=json", "--quiet"], {encoding: "utf8"}));
}
const vox = cloudJson(["run", "services", "describe", deployment.voxService]);
const runtime = servingStagingRevisions(vox, deployment).map((name: string) => assertStagingRevision(cloudJson(["run", "revisions", "describe", name]), deployment));
let clientSecret: string;
try {
  clientSecret = execFileSync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${deployment.populiClientsSecret}`, `--project=${deployment.projectId}`], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
} catch { throw new Error("Cannot read the configured staging provider client secret"); }
const client = selectStagingProviderClient(clientSecret, deployment.voxInstanceId);
clientSecret = "";
process.env.VOX_PREFLIGHT_POPULI_TOKEN = client.token;
const configuration = {populi_api_base_url: deployment.populiApiUrl, populi_api_token_env: "VOX_PREFLIGHT_POPULI_TOKEN"} as RealizeCreatorPayoutConfigurationV1;
try {
  const provider = new HttpPopuliRealizeClient();
  const capabilities = await provider.getCapabilities(configuration, deployment.creatorId);
  const video = capabilities.capabilities.find((item) => item.output_media_types.includes("video/mp4"));
  if (!video) throw new Error("Staging creator does not advertise video generation");
  const schema = await provider.getInputSchema(configuration, video.input_schema_uri, deployment.creatorId);
  const controls = videoOptions(schema, video.max_duration_seconds);
  console.log(JSON.stringify({provider: {origin: deployment.populiApiUrl, creator: capabilities.creator_id, providers: capabilities.generation_provider_ids, capability: video.capability_id, controls, scopedClientId: client.id, realVoxVerifierConfigured: true}, vox: {service: deployment.voxService, deployed: true, origin: vox.status.url, firestoreDatabase: deployment.firestoreDatabase, runtime}, payment: {network: deployment.network, mainnetEnabled: false}, note: "Read-only preflight. Serving revisions and scoped client verified. No quote, generation, wallet transaction or deployment was submitted."}, null, 2));
} finally { delete process.env.VOX_PREFLIGHT_POPULI_TOKEN; client.token = ""; }
