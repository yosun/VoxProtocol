import React, {useState} from "react";
import {useConnectedWallet, useWalletStatus, useWallets} from "@solana/kit-plugin-wallet/react";
import {solanaWalletClient} from "./solana-wallet.js";
import "./styles.css";

export function WalletConnectDialog({onClose}: {onClose: () => void}) {
  const connected = useConnectedWallet(solanaWalletClient);
  const wallets = useWallets(solanaWalletClient);
  const walletStatus = useWalletStatus(solanaWalletClient);
  const [error, setError] = useState("");

  async function connect(wallet: typeof wallets[number]): Promise<void> {
    setError("");
    try { await solanaWalletClient.wallet.connect(wallet); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Wallet connection was canceled. Try again."); }
  }

  return <div className="drawer-backdrop" onClick={onClose}><aside className="drawer wallet-dialog" role="dialog" aria-modal="true" aria-label="Connect a Solana wallet" onClick={(event) => event.stopPropagation()}>
    <button className="icon-button close" onClick={onClose} aria-label="Close wallet connection">×</button>
    <p className="eyebrow">VOX / Solana</p>
    <h2>{connected ? "Wallet connected." : "Bring your wallet into the world."}</h2>
    <p className="muted">Connect once, then use the same wallet when a character’s quote is ready. VOX never asks for a seed phrase.</p>
    {connected ? <div className="wallet-connected-state"><span className="wallet-connected-mark">✓</span><div><strong>Connected Solana wallet</strong><code>{connected.account.address}</code><span>Ready for a quote-bound USDC checkout.</span></div><button type="button" className="primary-button wide" onClick={onClose}>Done</button></div> : wallets.length > 0 ? <div className="wallet-dialog-options"><p className="eyebrow">Choose a compatible wallet</p>{wallets.map((wallet) => <button type="button" className="wallet-choice" key={wallet.name} onClick={() => void connect(wallet)}><span className="wallet-choice-mark">↗</span><span><strong>{wallet.name}</strong><small>{walletStatus === "pending" ? "Connecting…" : "Solana Wallet Standard"}</small></span><span aria-hidden="true">→</span></button>)}</div> : <div className="wallet-empty-state"><span className="wallet-connected-mark">◎</span><strong>No compatible wallet detected.</strong><p>Install a Wallet Standard Solana wallet, then return to VOX.</p></div>}
    {error && <div className="error-box" role="alert">{error}</div>}
  </aside></div>;
}
