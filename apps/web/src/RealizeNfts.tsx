import {useEffect, useState} from "react";
import {api, type NftMediaStatus} from "./api.js";
import {signNftClaim} from "./evm-wallet.js";
import {signRealizeRequest, type RealizeIdentity} from "./realize-identity.js";
import "./RealizeNfts.css";

const ACTIVE = new Set(["queued", "signing", "signed", "submitted", "retryable_failure"]);

function mintLabel(state: string): string {
  if (state === "claimable") return "Ready to mint";
  if (state === "finalized") return "Minted";
  if (state === "manual_review") return "Needs review";
  if (state === "retryable_failure") return "Delayed · retrying";
  return "Minting…";
}

export function RealizeNfts({mediaIds, identity}: {mediaIds: string[]; identity: RealizeIdentity | undefined}) {
  const [media, setMedia] = useState<NftMediaStatus[]>([]);
  const [busyMint, setBusyMint] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const mediaKey = mediaIds.join(",");

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const ids = mediaKey ? mediaKey.split(",") : [];
    setMedia([]);
    setError("");
    const poll = async () => {
      try {
        const records = await Promise.all(ids.map(async (id) => {
          let record = await api.nftMedia(id);
          if (identity) for (const mint of record.mints) {
            if (!ACTIVE.has(mint.state)) continue;
            const path = `/v1/nft/mints/${encodeURIComponent(mint.mint_id)}/sync`;
            record = await api.syncNftMint(mint.mint_id, await signRealizeRequest(identity, "POST", path, {}));
          }
          return record;
        }));
        if (!active) return;
        setMedia(records);
        setError("");
        if (records.some((record) => record.mints.some((mint) => ACTIVE.has(mint.state)))) timer = window.setTimeout(() => void poll(), 5_000);
      } catch (reason) {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "NFT status is temporarily unavailable.");
        timer = window.setTimeout(() => void poll(), 5_000);
      }
    };
    if (ids.length) void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [mediaKey, identity, refresh]);

  async function claim(record: NftMediaStatus, mint: NftMediaStatus["mints"][number]) {
    if (!identity || busyMint || mint.state !== "claimable") return;
    setBusyMint(mint.mint_id);
    setError("");
    try {
      const proof = await signNftClaim(mint.chain, {mint_id: mint.mint_id, created_at: mint.created_at ?? record.created_at});
      const path = `/v1/nft/mints/${encodeURIComponent(mint.mint_id)}/claim`;
      await api.claimNftMint(mint.mint_id, proof, await signRealizeRequest(identity, "POST", path, proof));
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not mint. Refresh the saved status before trying again.");
      try {
        const recovered = await api.nftMedia(record.media_id);
        setMedia((current) => current.map((item) => item.media_id === recovered.media_id ? recovered : item));
        if (recovered.mints.some((item) => ACTIVE.has(item.state))) setRefresh((value) => value + 1);
      } catch { /* The refresh button can recover a lost response without rebinding a transaction. */ }
    } finally { setBusyMint(""); }
  }

  if (!mediaKey) return null;
  return <div className="realize-nfts" aria-label="NFT minting status">
    {media.length === 0 && !error && <p role="status">Loading your NFT records…</p>}
    {media.map((record) => <div className="nft-status-card" key={record.media_id}>
      <div className="nft-status-heading"><div><p className="eyebrow">Your creation · Output {record.output_index + 1}</p><strong>Mint your creation</strong></div><a href={record.media_page_url ?? `/media/${encodeURIComponent(record.media_id)}`} target="_blank" rel="noreferrer">Open VOX media page ↗</a></div>
      <p><a className="nft-output-link" href={record.media_uri} target="_blank" rel="noreferrer">Preview this output ↗</a></p>
      <div className="nft-chain-statuses">{record.mints.map((mint) => {
        const monad = mint.chain.startsWith("monad:");
        const tokenUrl = monad && mint.state === "finalized" && mint.asset_address && mint.token_id ? `https://${mint.chain === "monad:testnet" ? "testnet." : ""}monadscan.com/token/${mint.asset_address}?a=${mint.token_id}` : undefined;
        return <div className="nft-chain-status" key={mint.mint_id} aria-live="polite">
          <span>{monad ? mint.chain === "monad:testnet" ? "Monad Testnet" : "Monad" : mint.chain.replace(":", " · ")}</span>
          <strong>{mintLabel(mint.state)}{mint.state === "finalized" && mint.token_id ? ` · Token #${mint.token_id}` : ""}</strong>
          {mint.state === "claimable" && !mint.chain.startsWith("solana:") && <button type="button" className="secondary-button" onClick={() => void claim(record, mint)} disabled={!!busyMint || !identity}>{busyMint === mint.mint_id ? "Confirm in your wallet…" : monad ? "Mint on Monad" : `Mint on ${mint.chain.split(":")[0]}`}</button>}
          {mint.explorer_url && <a href={mint.explorer_url} target="_blank" rel="noreferrer">View transaction ↗</a>}
          {tokenUrl && <a href={tokenUrl} target="_blank" rel="noreferrer">View your NFT ↗</a>}
          {mint.state === "manual_review" && <span className="tiny muted">VOX saved the transaction for review.</span>}
        </div>;
      })}</div>
      {record.mints.some((mint) => mint.state === "claimable" && mint.chain.startsWith("monad:")) && <p className="tiny muted">Connect an EVM wallet and sign to choose your receiving address. VOX pays the minting gas.</p>}
    </div>)}
    {error && <p className="error-box" role="alert">{error} <button type="button" className="secondary-button" disabled={!!busyMint} onClick={() => setRefresh((value) => value + 1)}>Refresh NFT status</button></p>}
  </div>;
}
