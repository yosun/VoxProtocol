import {pathToFileURL} from "node:url";

export interface RealizeReconcileSummary {
  processed: number;
  failed: number;
}

export async function runRealizeReconciliation(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: typeof fetch = fetch
): Promise<RealizeReconcileSummary> {
  const apiUrl = env.VOX_API_URL?.trim();
  const token = env.VOX_INTERNAL_TOKEN;
  const limitText = env.VOX_REALIZE_RECONCILE_LIMIT?.trim() ?? "10";
  if (!apiUrl || !token || token.length < 32 || !/^[1-9][0-9]?$/.test(limitText)) {
    throw new Error("Realize reconciliation requires an HTTPS API URL, internal token, and a limit from 1 to 99");
  }
  const base = new URL(apiUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Realize reconciliation API URL must be a clean HTTPS origin");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetcher(new URL("/v1/internal/realize/reconcile", base), {
      method: "POST",
      headers: {authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json"},
      body: JSON.stringify({limit: Number(limitText)}),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Realize reconciliation API returned HTTP ${response.status}`);
    const payload = await response.json() as {processed?: unknown; commissions?: unknown};
    if (!Number.isInteger(payload.processed) || !Array.isArray(payload.commissions)) {
      throw new Error("Realize reconciliation API returned an invalid response");
    }
    const failed = payload.commissions.filter((item) => !!item && typeof item === "object" && "error" in item).length;
    return {processed: payload.processed as number, failed};
  } finally {
    clearTimeout(timeout);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runRealizeReconciliation();
  console.log(JSON.stringify(result));
  if (result.failed > 0) throw new Error(`${result.failed} Realize commissions need another reconciliation attempt`);
}
