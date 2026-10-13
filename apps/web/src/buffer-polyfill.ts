import {Buffer} from "buffer";

// Solana's SPL Token packages use the Buffer global during module initialization.
// Initialize it before importing the wallet and token SDKs in the browser bundle.
(globalThis as typeof globalThis & {Buffer?: typeof Buffer}).Buffer ??= Buffer;
