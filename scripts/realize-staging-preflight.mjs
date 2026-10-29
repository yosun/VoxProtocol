import assert from "node:assert/strict";

export function assertStagingDeployment(deployment) {
  assert.equal(deployment.environment, "staging", "Preflight requires the staging environment");
  assert.equal(deployment.projectId, "crueltycam", "Staging credentials belong to crueltycam");
  assert.equal(deployment.region, "us-east1", "Unexpected staging region");
  assert.equal(deployment.voxService, "vox-realize-staging", "Unexpected staging service");
  assert.equal(deployment.voxInstanceId, "instance:vox-realize-staging", "Unexpected staging instance");
  assert.equal(deployment.firestoreDatabase, "vox-realize-staging", "Staging requires its isolated database");
  assert.equal(deployment.network, "solana:devnet", "Staging must use Devnet");
  assert.equal(deployment.mainnetEnabled, false, "Staging must disable Mainnet");
  assert.equal(deployment.populiApiUrl, "https://staging.populi.cam", "Unexpected staging provider origin");
  assert.equal(deployment.populiClientsSecret, "populi-realize-staging-realize-clients", "Unexpected staging client secret");
}

export function servingStagingRevisions(service, deployment) {
  assert.equal(service.metadata?.name, deployment.voxService, "Cloud Run returned another service");
  assert.ok(service.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True"), "Staging service is not ready");
  // A tag URL remains callable even at zero percent of the default traffic.
  const traffic = (service.status?.traffic ?? []).filter((target) => target.percent > 0 || typeof target.tag === "string");
  assert.equal(traffic.reduce((total, target) => total + (target.percent ?? 0), 0), 100, "Cannot account for all serving staging traffic");
  assert.ok(traffic.every((target) => typeof target.revisionName === "string" && target.revisionName.startsWith(`${deployment.voxService}-`)), "Staging traffic has an unknown revision");
  return [...new Set(traffic.map((target) => target.revisionName))];
}

export function assertStagingRevision(revision, deployment) {
  assert.ok(typeof revision.metadata?.name === "string" && revision.metadata.name.startsWith(`${deployment.voxService}-`), "Unexpected staging revision identity");
  assert.equal(revision.spec?.containers?.length, 1, "Expected one staging application container");
  const entries = revision.spec.containers[0].env ?? [];
  const expected = {
    GOOGLE_CLOUD_PROJECT: deployment.projectId,
    VOX_FIRESTORE_DATABASE: deployment.firestoreDatabase,
    VOX_INSTANCE_ID: deployment.voxInstanceId,
    VOX_SOLANA_CLUSTER: "devnet",
    VOX_REALIZE_DEVNET_ENABLED: "true",
    VOX_REALIZE_MAINNET_ENABLED: "false"
  };
  for (const [name, value] of Object.entries(expected)) {
    const matches = entries.filter((entry) => entry.name === name);
    assert.equal(matches.length, 1, `Serving staging revision must declare ${name} exactly once`);
    assert.equal(matches[0].value, value, `Serving staging revision has unsafe ${name}`);
  }
  assert.ok(revision.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True"), "Serving staging revision is not ready");
  return {revision: revision.metadata.name, network: "solana:devnet", devnetEnabled: true, mainnetEnabled: false, firestoreDatabase: deployment.firestoreDatabase};
}

export function selectStagingProviderClient(secretJson, instanceId) {
  let clients;
  try { clients = JSON.parse(secretJson); }
  catch { throw new Error("Staging provider client secret is not valid JSON"); }
  if (!Array.isArray(clients)) throw new Error("Staging provider client secret must contain a client list");
  const matches = clients.filter((client) => Array.isArray(client?.verifier_ids) && client.verifier_ids.includes(instanceId) && Array.isArray(client.scopes) && client.scopes.includes("capabilities:read") && typeof client.token === "string" && client.token.length > 0);
  if (matches.length !== 1) throw new Error("Exactly one staging provider client must authorize this VOX instance and capabilities:read");
  return matches[0];
}
