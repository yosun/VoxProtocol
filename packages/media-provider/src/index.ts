import { bytesToHex, domainHash, utf8 } from "@vox/protocol";
import { z } from "zod";

export const MediaStyleSchema = z.enum(["cinematic", "portrait", "documentary", "ambient"]);
export type MediaStyle = z.infer<typeof MediaStyleSchema>;

export interface MediaQuoteRequest {
  post_id: string;
  style: MediaStyle;
  duration_seconds: number;
  requester_id: string;
}

export interface MediaQuote {
  quote_id: string;
  post_id: string;
  amount_usdc_atomic: string;
  currency: "USDC";
  expires_at: string;
  provider_id: string;
  mock: boolean;
}

export interface MediaGenerationRequest {
  quote_id: string;
  post_id: string;
  payment_reference: string;
  requester_id: string;
  generation_description?: string;
}

export type MediaJobStatus = "queued" | "processing" | "delivered" | "failed" | "refundable";

export interface MediaJob {
  job_id: string;
  provider_id: string;
  post_id: string;
  status: MediaJobStatus;
  media_url?: string;
  media_hash?: string;
  error?: string;
  refund_eligible: boolean;
}

export interface MediaProvider {
  quote(request: MediaQuoteRequest): Promise<MediaQuote>;
  requestGeneration(request: MediaGenerationRequest): Promise<MediaJob>;
  status(jobId: string): Promise<MediaJob>;
}

export class MockMediaProvider implements MediaProvider {
  readonly providerId = "vox.mock-media.v1";
  private readonly jobs = new Map<string, MediaJob>();

  async quote(request: MediaQuoteRequest): Promise<MediaQuote> {
    if (request.duration_seconds < 1 || request.duration_seconds > 120) throw new Error("Duration must be between 1 and 120 seconds");
    const quoteId = `quote_${bytesToHex(domainHash("vox.mock.quote.v1", utf8(JSON.stringify(request)))).slice(0, 24)}`;
    return {
      quote_id: quoteId,
      post_id: request.post_id,
      amount_usdc_atomic: String(250_000 + request.duration_seconds * 25_000),
      currency: "USDC",
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      provider_id: this.providerId,
      mock: true
    };
  }

  async requestGeneration(request: MediaGenerationRequest): Promise<MediaJob> {
    const jobId = `job_${bytesToHex(domainHash("vox.mock.job.v1", utf8(`${request.quote_id}:${request.payment_reference}:${request.post_id}:${request.generation_description ?? ""}`))).slice(0, 24)}`;
    const job: MediaJob = {
      job_id: jobId,
      provider_id: this.providerId,
      post_id: request.post_id,
      status: "delivered",
      media_url: `https://example.invalid/vox/mock/${jobId}.mp4`,
      media_hash: bytesToHex(domainHash("vox.mock.media.v1", utf8(jobId))),
      refund_eligible: false
    };
    this.jobs.set(jobId, job);
    return job;
  }

  async status(jobId: string): Promise<MediaJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Media job not found");
    return job;
  }
}
