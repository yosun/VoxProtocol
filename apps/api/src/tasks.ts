import {CloudTasksClient} from "@google-cloud/tasks";

export interface AnchorTaskDispatcher {
  enqueue(input: {post_id: string; tier: string}): Promise<void>;
}

export class NoopAnchorTaskDispatcher implements AnchorTaskDispatcher {
  async enqueue(_input: {post_id: string; tier: string}): Promise<void> {
    // Scheduler polling remains the fallback when Cloud Tasks is not configured.
  }
}

export class CloudTasksAnchorTaskDispatcher implements AnchorTaskDispatcher {
  private readonly client: CloudTasksClient;
  private readonly parent: string;
  private readonly workerUrl: string;
  private readonly workerAudience: string;
  private readonly serviceAccountEmail: string | undefined;

  constructor(options: {projectId: string; location: string; queue: string; workerUrl: string; workerAudience?: string; serviceAccountEmail?: string}) {
    this.client = new CloudTasksClient();
    this.parent = this.client.queuePath(options.projectId, options.location, options.queue);
    this.workerUrl = options.workerUrl;
    this.workerAudience = options.workerAudience ?? options.workerUrl.replace(/\/run\/?$/, "");
    this.serviceAccountEmail = options.serviceAccountEmail;
  }

  async enqueue(input: {post_id: string; tier: string}): Promise<void> {
    const task = {
      httpRequest: {
        httpMethod: "POST" as const,
        url: this.workerUrl,
        headers: {"content-type": "application/json"},
        body: Buffer.from(JSON.stringify(input)).toString("base64"),
        ...(this.serviceAccountEmail ? {oidcToken: {serviceAccountEmail: this.serviceAccountEmail, audience: this.workerAudience}} : {})
      }
    };
    await this.client.createTask({parent: this.parent, task});
  }
}

export function createAnchorTaskDispatcherFromEnv(): AnchorTaskDispatcher {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.VOX_TASKS_LOCATION;
  const queue = process.env.VOX_TASKS_QUEUE;
  const workerUrl = process.env.VOX_ANCHOR_WORKER_URL;
  const workerAudience = process.env.VOX_ANCHOR_WORKER_AUDIENCE;
  const serviceAccountEmail = process.env.VOX_TASKS_SERVICE_ACCOUNT;
  if (!projectId || !location || !queue || !workerUrl || !serviceAccountEmail) return new NoopAnchorTaskDispatcher();
  return new CloudTasksAnchorTaskDispatcher({projectId, location, queue, workerUrl, serviceAccountEmail, ...(workerAudience ? {workerAudience} : {})});
}
