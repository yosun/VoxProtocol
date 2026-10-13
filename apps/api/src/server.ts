import { buildApp } from "./app.js";

const app = await buildApp();
const port = Number.parseInt(process.env.PORT ?? process.env.VOX_PORT ?? "8787", 10);
const host = process.env.VOX_HOST ?? "0.0.0.0";
await app.listen({port, host});

const shutdown = async (signal: string) => {
  app.log.info(`received ${signal}; shutting down`);
  await app.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
