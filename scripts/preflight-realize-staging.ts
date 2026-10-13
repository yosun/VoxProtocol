import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {HttpPopuliRealizeClient, type RealizeCreatorPayoutConfigurationV1} from "../apps/api/src/realize-engine.js";
import {videoOptions} from "../apps/web/src/realize-parameters.js";

const deployment = JSON.parse(readFileSync(new URL("../deployments/realize-staging.json", import.meta.url), "utf8"));
const clients = JSON.parse(execFileSync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${deployment.populiClientsSecret}`, `--project=${deployment.projectId}`], {encoding: "utf8"}));
const client = clients.find((item: {verifier_ids: string[]}) => item.verifier_ids.includes(deployment.voxInstanceId)) ?? clients.find((item: {scopes: string[]}) => item.scopes.includes("capabilities:read"));
if (!client?.token) throw new Error("No configured staging provider client can read capabilities");
process.env.VOX_PREFLIGHT_POPULI_TOKEN = client.token;
const configuration = {populi_api_base_url: deployment.populiApiUrl, populi_api_token_env: "VOX_PREFLIGHT_POPULI_TOKEN"} as RealizeCreatorPayoutConfigurationV1;
try {
  const provider = new HttpPopuliRealizeClient();
  const capabilities = await provider.getCapabilities(configuration, deployment.creatorId);
  const video = capabilities.capabilities.find((item) => item.output_media_types.includes("video/mp4"));
  if (!video) throw new Error("Staging creator does not advertise video generation");
  const schema = await provider.getInputSchema(configuration, video.input_schema_uri, deployment.creatorId);
  const controls = videoOptions(schema, video.max_duration_seconds);
  const serviceList = JSON.parse(execFileSync("gcloud", ["run", "services", "list", `--project=${deployment.projectId}`, `--region=${deployment.region}`, "--format=json"], {encoding: "utf8"}));
  const vox = serviceList.find((item: {metadata: {name: string}}) => item.metadata.name === deployment.voxService);
  console.log(JSON.stringify({provider: {origin: deployment.populiApiUrl, creator: capabilities.creator_id, providers: capabilities.generation_provider_ids, capability: video.capability_id, controls, scopedClientId: client.id, realVoxVerifierConfigured: client.verifier_ids.includes(deployment.voxInstanceId)}, vox: {service: deployment.voxService, deployed: !!vox, origin: vox?.status?.url, firestoreDatabase: deployment.firestoreDatabase}, payment: {network: deployment.network, mainnetEnabled: false}, note: "Read-only preflight. No quote, generation, wallet transaction or deployment was submitted."}, null, 2));
} finally { delete process.env.VOX_PREFLIGHT_POPULI_TOKEN; }
