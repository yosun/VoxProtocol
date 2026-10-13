import {describe, expect, it} from "vitest";
import {MAINNET_USDC_MINT} from "@vox/realize-solana";
import {deriveMainnetTreasuryUsdcAta, resolveMainnetTreasuryUsdcAta} from "../apps/api/src/realize-mainnet-ata.js";

const treasuryOwner = "5Uvtth32oEiA9BG8XjzfTgwn9kry9iUQsYHnggxLpzgA";

describe("Mainnet Realize treasury ATA configuration", () => {
  it("derives the classic USDC associated token account from the approved treasury owner", () => {
    expect(deriveMainnetTreasuryUsdcAta(treasuryOwner, MAINNET_USDC_MINT))
      .toBe("C5txndLZDr6GyFMgFjFEKyavPDJGAnkVB6EdnDUd1W26");
  });

  it("rejects alternate mints so Devnet or mock token accounts cannot become the Mainnet treasury", () => {
    expect(() => deriveMainnetTreasuryUsdcAta(treasuryOwner, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"))
      .toThrow("pinned to the official Mainnet USDC mint");
  });

  it("rejects the transposed account address used by the previous deployment default", () => {
    expect(() => resolveMainnetTreasuryUsdcAta(
      treasuryOwner,
      MAINNET_USDC_MINT,
      "C5txndLZDr6GyFMgFjFEKyavPDJGAnkVB6EdnDU1dW26"
    )).toThrow("does not match the owner and mint derived ATA");
  });

  it("keeps the deployment default derived from the owner and mint", () => {
    expect(resolveMainnetTreasuryUsdcAta(treasuryOwner, MAINNET_USDC_MINT))
      .toBe("C5txndLZDr6GyFMgFjFEKyavPDJGAnkVB6EdnDUd1W26");
  });
});
