import {defineConfig, devices} from "@playwright/test";

const port = Number(process.env.VOX_E2E_PORT ?? "5181");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("VOX_E2E_PORT must be a port from 1024 to 65535");
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  expect: {timeout: 10_000},
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    command: `VITE_API_URL=http://localhost:8787 VITE_SOLANA_CLUSTER=mainnet-beta VITE_REALIZE_MAINNET_ENABLED=true npm run dev --workspace @vox/web -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
