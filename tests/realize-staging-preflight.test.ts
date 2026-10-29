import {describe, expect, it} from "vitest";
import {assertStagingDeployment, assertStagingRevision, selectStagingProviderClient, servingStagingRevisions} from "../scripts/realize-staging-preflight.mjs";
import deployment from "../deployments/realize-staging.json";

const ready = [{type: "Ready", status: "True"}];
function revision(overrides: Record<string, string> = {}) {
  const env = {GOOGLE_CLOUD_PROJECT: "crueltycam", VOX_FIRESTORE_DATABASE: "vox-realize-staging", VOX_INSTANCE_ID: "instance:vox-realize-staging", VOX_SOLANA_CLUSTER: "devnet", VOX_REALIZE_DEVNET_ENABLED: "true", VOX_REALIZE_MAINNET_ENABLED: "false", ...overrides};
  return {metadata: {name: "vox-realize-staging-00023-test"}, spec: {containers: [{env: Object.entries(env).map(([name, value]) => ({name, value}))}]}, status: {conditions: ready}};
}

describe("staging financial isolation preflight", () => {
  it("requires the known staging project before reading credentials", () => {
    expect(() => assertStagingDeployment(deployment)).not.toThrow();
    expect(() => assertStagingDeployment({...deployment, projectId: "voxprotocol"})).toThrow(/crueltycam/);
    expect(() => assertStagingDeployment({...deployment, network: "solana:mainnet-beta"})).toThrow(/Devnet/);
    expect(() => assertStagingDeployment({...deployment, populiClientsSecret: "cruelty-populi-realize-clients"})).toThrow(/client secret/);
  });

  it("verifies all traffic-bearing and tagged revisions instead of only the latest template", () => {
    const service = {metadata: {name: deployment.voxService}, status: {conditions: ready, traffic: [{revisionName: "vox-realize-staging-old", percent: 40}, {revisionName: "vox-realize-staging-new", percent: 60}, {revisionName: "vox-realize-staging-tag", tag: "candidate"}]}};
    expect(servingStagingRevisions(service, deployment)).toEqual(["vox-realize-staging-old", "vox-realize-staging-new", "vox-realize-staging-tag"]);
    expect(() => assertStagingRevision(revision({VOX_REALIZE_MAINNET_ENABLED: "true"}), deployment)).toThrow(/MAINNET/);
    expect(() => servingStagingRevisions({...service, status: {...service.status, traffic: []}}, deployment)).toThrow(/traffic/);
  });

  it.each(["VOX_REALIZE_MAINNET_ENABLED", "VOX_REALIZE_DEVNET_ENABLED", "VOX_SOLANA_CLUSTER", "GOOGLE_CLOUD_PROJECT", "VOX_FIRESTORE_DATABASE", "VOX_INSTANCE_ID"])("fails closed when the serving revision has unsafe %s", (name) => {
    expect(() => assertStagingRevision(revision({[name]: "wrong"}), deployment)).toThrow(name);
  });

  it("reports a verified ready isolated revision", () => {
    expect(assertStagingRevision(revision(), deployment)).toMatchObject({network: "solana:devnet", mainnetEnabled: false, devnetEnabled: true});
    expect(() => assertStagingRevision({...revision(), status: {conditions: []}}, deployment)).toThrow(/not ready/);
  });

  it("rejects fallback clients, duplicate authorizations, and missing scopes", () => {
    const valid = {id: "staging", verifier_ids: [deployment.voxInstanceId], scopes: ["capabilities:read"], token: "test-only-token"};
    expect(selectStagingProviderClient(JSON.stringify([valid]), deployment.voxInstanceId).id).toBe("staging");
    expect(() => selectStagingProviderClient(JSON.stringify([{...valid, verifier_ids: ["another-instance"]}]), deployment.voxInstanceId)).toThrow(/Exactly one/);
    expect(() => selectStagingProviderClient(JSON.stringify([{...valid, scopes: []}]), deployment.voxInstanceId)).toThrow(/Exactly one/);
    expect(() => selectStagingProviderClient(JSON.stringify([valid, valid]), deployment.voxInstanceId)).toThrow(/Exactly one/);
    expect(() => selectStagingProviderClient('{"token":"do-not-echo', deployment.voxInstanceId)).toThrow("Staging provider client secret is not valid JSON");
  });
});
