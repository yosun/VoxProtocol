import React, {useEffect, useRef, useState} from "react";
import {useConnectedWallet, useWalletStatus, useWallets} from "@solana/kit-plugin-wallet/react";
import {solanaWalletClient} from "./solana-wallet.js";
import "./styles.css";

export function WalletConnectDialog({onClose, onConnected}: {onClose: () => void; onConnected?: () => void}) {
  const connected = useConnectedWallet(solanaWalletClient);
  const wallets = useWallets(solanaWalletClient);
  const walletStatus = useWalletStatus(solanaWalletClient);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const operationPending = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const pending = working || walletStatus === "pending" || walletStatus === "reconnecting";

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if (event.key === "Tab") {
        const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]") ?? []);
        const first = items[0];
        const last = items[items.length - 1];
        if (first && last && (!dialog.current?.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("keydown", keyDown, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  async function connect(wallet: typeof wallets[number]): Promise<void> {
    if (operationPending.current || pending) return;
    operationPending.current = true;
    setWorking(true);
    setError("");
    try { await solanaWalletClient.wallet.connect(wallet); onConnected?.(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Wallet connection was canceled. Try again."); }
    finally { operationPending.current = false; setWorking(false); }
  }

  async function disconnect(): Promise<void> {
    if (operationPending.current || pending) return;
    operationPending.current = true;
    setWorking(true);
    setError("");
    try { await solanaWalletClient.wallet.disconnect(); }
    catch { setError("Could not disconnect the wallet. Try again."); }
    finally { operationPending.current = false; setWorking(false); }
  }

  return <div className="drawer-backdrop" onClick={onClose}><aside ref={dialog} className="drawer wallet-dialog" role="dialog" aria-modal="true" aria-label="Connect a Solana wallet" onClick={(event) => event.stopPropagation()}>
    <button className="icon-button close" onClick={onClose} aria-label="Close wallet connection">×</button>
    <p className="eyebrow">VOX / Solana</p>
    <h2>{connected ? "Wallet connected." : "Bring your wallet into the world."}</h2>
    <p className="muted">Connect once, then use the same wallet when a character’s quote is ready. VOX never asks for a seed phrase.</p>
    {connected ? <div className="wallet-connected-state"><span className="wallet-connected-mark">✓</span><div><strong>Connected Solana wallet</strong><code>{connected.account.address}</code><span>Ready for a quote-bound USDC checkout.</span></div><button type="button" className="primary-button wide" onClick={onClose}>Done</button><button type="button" className="secondary-button wide" disabled={pending} onClick={() => void disconnect()}>Disconnect wallet</button></div> : wallets.length > 0 ? <div className="wallet-dialog-options"><p className="eyebrow">Choose a compatible wallet</p>{wallets.map((wallet) => <button type="button" className="wallet-choice" key={wallet.name} disabled={pending} onClick={() => void connect(wallet)}><span className="wallet-choice-mark">↗</span><span><strong>{wallet.name}</strong><small>{pending ? "Connecting…" : wallet.name === "Solflare Web Wallet" ? "Use a wallet in your browser, no extension required" : "Solana Wallet Standard"}</small></span><span aria-hidden="true">→</span></button>)}{wallets.some((wallet) => wallet.name === "Solflare Web Wallet") && <p className="tiny muted">Solflare opens in a separate window. You’ll need USDC and a little SOL for network fees.</p>}</div> : <div className="wallet-empty-state"><span className="wallet-connected-mark">◎</span><strong>No compatible wallet detected.</strong><p>On a phone, open VOX.gold in your Solana wallet’s browser. On desktop, install or enable a wallet extension for this browser, then reload VOX.</p><div className="wallet-options"><a className="secondary-button" href="https://phantom.com/download" target="_blank" rel="noopener noreferrer">Get Phantom ↗</a><a className="secondary-button" href="https://www.solflare.com/download/" target="_blank" rel="noopener noreferrer">Get Solflare ↗</a></div><p>Wallet extensions may be unavailable in private windows and embedded browsers.</p></div>}
    {error && <div className="error-box" role="alert">{error}</div>}
  </aside></div>;
}
