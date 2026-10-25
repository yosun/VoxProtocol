import {describe, expect, it} from "vitest";
import {MemoryStore} from "../apps/api/src/store.js";
import type {RealizeCommissionRecord} from "../apps/api/src/types.js";

function commissionRecord(id: string, state: string, updatedAt: string): RealizeCommissionRecord {
  return {
    commission: {commission_id: `vox:commission:${id}`, state, updated_at: updatedAt},
    settlement_status: "not_started",
    created_at: updatedAt,
    updated_at: updatedAt
  } as unknown as RealizeCommissionRecord;
}

describe("Realize reconciliation queue", () => {
  it("keeps paid work ahead of old drafts and leaves manual or terminal records out", async () => {
    const store = new MemoryStore();
    const old = "2020-01-01T00:00:00.000Z";
    for (let index = 0; index < 20; index += 1) {
      await store.createRealizeCommission(commissionRecord(`draft-${index}`, "DRAFT", old));
      await store.createRealizeCommission(commissionRecord(`manual-${index}`, "MANUAL_REVIEW", old));
      await store.createRealizeCommission(commissionRecord(`settled-${index}`, "SETTLED", old));
    }
    const paidId = "vox:commission:funded-new-order";
    const paid = commissionRecord("funded-new-order", "FUNDED", "2026-10-13T00:00:00.000Z");
    await store.createRealizeCommission(paid);

    const batch = await store.listRealizeCommissions(10);

    expect(batch.map((record) => record.commission.commission_id)).toContain(paidId);
    expect(batch.every((record) => !["DRAFT", "MANUAL_REVIEW", "SETTLED"].includes(record.commission.state))).toBe(true);
    expect(batch).toHaveLength(1);
  });

  it("reserves bounded work for delivery recovery and quote expiry", async () => {
    const store = new MemoryStore();
    const old = "2020-01-01T00:00:00.000Z";
    for (let index = 0; index < 20; index += 1) {
      await store.createRealizeCommission(commissionRecord(`generating-${index}`, "GENERATING", old));
      await store.createRealizeCommission(commissionRecord(`completed-${index}`, "COMPLETED", old));
      await store.createRealizeCommission(commissionRecord(`awaiting-${index}`, "AWAITING_PAYMENT", old));
    }

    const batch = await store.listRealizeCommissions(10);
    const counts = batch.reduce<Record<string, number>>((result, record) => {
      result[record.commission.state] = (result[record.commission.state] ?? 0) + 1;
      return result;
    }, {});

    expect(batch).toHaveLength(10);
    expect(counts).toEqual({GENERATING: 6, COMPLETED: 2, AWAITING_PAYMENT: 2});
  });

  it("does not let a delivery backlog consume the reserved quote-expiry slots", async () => {
    const store = new MemoryStore();
    const old = "2020-01-01T00:00:00.000Z";
    for (let index = 0; index < 20; index += 1) {
      await store.createRealizeCommission(commissionRecord(`completed-${index}`, "COMPLETED", old));
      await store.createRealizeCommission(commissionRecord(`awaiting-${index}`, "AWAITING_PAYMENT", old));
    }

    const batch = await store.listRealizeCommissions(10);
    const counts = batch.reduce<Record<string, number>>((result, record) => {
      result[record.commission.state] = (result[record.commission.state] ?? 0) + 1;
      return result;
    }, {});

    expect(counts).toEqual({COMPLETED: 8, AWAITING_PAYMENT: 2});
  });
});
