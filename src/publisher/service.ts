import { createHash } from "node:crypto";
import type { NormalizedConfigModel } from "../config/v2.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type { OutboxProcessor } from "../outbox.js";
import type { ConversationRef } from "../platform/types.js";
import type { BuzzEndpointHealth } from "../platform/buzz/transport.js";
import type { PublishBody } from "./schemas.js";

export interface PublisherServiceDeps {
  normalized: NormalizedConfigModel;
  db: GatewayDB;
  outbox: OutboxProcessor;
  health: () => readonly BuzzEndpointHealth[];
}

export function canonicalPublisherPayload(body: PublishBody): string {
  return JSON.stringify({
    content: body.content,
    severity: body.severity,
    source: body.source,
  });
}

export class PublisherService {
  constructor(private readonly deps: PublisherServiceDeps) {}

  hasPublisher(id: string): boolean {
    return (this.deps.normalized.publishers ?? []).some((p) => p.id === id);
  }

  publish(publisherId: string, idempotencyKey: string, body: PublishBody) {
    const publisher = (this.deps.normalized.publishers ?? []).find(
      (candidate) => candidate.id === publisherId,
    );
    const api = this.deps.normalized.publisherApi;
    const retention = this.deps.normalized.retention;
    if (!publisher || !api || !retention) {
      return {
        kind: "rejected" as const,
        reason: "publisher_disabled" as const,
      };
    }
    const endpoint = this.deps.normalized.endpoints.find(
      (candidate) =>
        candidate.id === publisher.endpointId &&
        candidate.principalKind === "publisher",
    );
    if (!endpoint) {
      return {
        kind: "rejected" as const,
        reason: "publisher_disabled" as const,
      };
    }
    const state = this.deps.db.getEndpointState(endpoint.id);
    const snapshot = this.deps
      .health()
      .find((candidate) => candidate.endpointId === endpoint.id);
    const healthy =
      snapshot?.state === "healthy" &&
      !!state?.cursor.channels?.includes(publisher.destinationConversationId);
    const canonical = canonicalPublisherPayload(body);
    const conversation: ConversationRef = {
      platform: "buzz",
      communityId: endpoint.communityId,
      endpointId: endpoint.id,
      channelId: publisher.destinationConversationId,
      threadRootId: null,
      workflowRunId: null,
      type: "stream",
    };
    return this.deps.outbox.queuePublisherOperation({
      publisherId,
      conversation,
      idempotencyKey,
      payloadSha256: createHash("sha256")
        .update(canonical, "utf8")
        .digest("hex"),
      content: body.content,
      healthy,
      maxPending: api.max_pending_per_publisher,
      maxRetained: api.max_retained_per_publisher,
      maxRetainedBytes: api.max_retained_bytes_per_publisher,
      ratePerMinute: api.rate_per_minute_per_publisher,
      burst: api.burst_per_publisher,
      databaseSizeCapBytes: retention.database_size_cap_bytes,
      admissionBytes: Math.max(
        Buffer.byteLength(canonical, "utf8") + 8192,
        api.max_body_bytes + 8192,
      ),
    });
  }
}
