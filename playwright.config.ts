import {defineConfig, devices} from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  expect: {timeout: 10_000},
  use: {
    baseURL: "http://127.0.0.1:5181",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    command: "VITE_API_URL=http://localhost:8787 VITE_SOLANA_CLUSTER=mainnet-beta VITE_REALIZE_MAINNET_ENABLED=true npm run dev --workspace @vox/web -- --host 127.0.0.1 --port 5181 --strictPort",
    url: "http://127.0.0.1:5181",
    reuseExistingServer: false,
    timeout: 120_000
  }
});
