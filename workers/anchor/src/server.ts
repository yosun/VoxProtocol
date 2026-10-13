import {createServer, type Server} from "node:http";
import {runAnchorOnce, type AnchorRunResult} from "./index.js";

type WorkerAuthMode = "iam" | "token" | "none";
type WorkerHeaders = Record<string, string | string[] | undefined>;

export function workerAuthorized(headers: WorkerHeaders, mode: WorkerAuthMode, expectedToken?: string): boolean {
  if (mode === "none" || mode === "iam") return true;
  return !!expectedToken && headers["x-vox-worker-token"] === expectedToken;
}

function configuredAuthMode(): WorkerAuthMode {
  const configured = process.env.VOX_WORKER_AUTH_MODE;
  if (configured === "iam" || configured === "token" || configured === "none") return configured;
  if (process.env.VOX_WORKER_TOKEN) return "token";
  return process.env.NODE_ENV === "production" ? "iam" : "none";
}

export function createAnchorServer(run: () => Promise<AnchorRunResult> = runAnchorOnce): Server {
  const authMode = configuredAuthMode();
  const expectedToken = process.env.VOX_WORKER_TOKEN;
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/run") {
      response.writeHead(404, {"content-type": "application/json"});
      response.end(JSON.stringify({error: "not found"}));
      return;
    }
    if (!workerAuthorized(request.headers, authMode, expectedToken)) {
      response.writeHead(401, {"content-type": "application/json"});
      response.end(JSON.stringify({error: "unauthorized"}));
      return;
    }
    try {
      const result = await run();
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, {"content-type": "application/json"});
      response.end(JSON.stringify({error: error instanceof Error ? error.message : "anchor run failed"}));
    }
  });
}

if (process.argv[1]?.endsWith("server.js")) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const server = createAnchorServer();
  server.listen(port, "0.0.0.0", () => console.log(`anchor worker listening on ${port}`));
}
