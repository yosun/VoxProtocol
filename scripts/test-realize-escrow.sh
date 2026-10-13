#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
export NO_DNA=1
cargo fmt --all
cargo fmt --all --check
cargo build-sbf --manifest-path programs/realize-escrow/Cargo.toml
cargo test -p realize-escrow --test adversarial --locked
cargo test -p realize-escrow --test adversarial --locked --no-default-features --features devnet
cargo test -p realize-escrow --test adversarial --locked --no-default-features --features mainnet
cargo build-sbf --manifest-path programs/realize-escrow/Cargo.toml --no-default-features --features devnet
cargo build-sbf --manifest-path programs/realize-escrow/Cargo.toml --no-default-features --features mainnet
# Restore the localnet binary used by the disposable validator below.
cargo build-sbf --manifest-path programs/realize-escrow/Cargo.toml
# Compare generated interfaces with the checked-in artifacts; do not silently accept drift.
idl_tmp=$(mktemp -d)
trap 'rm -rf "$idl_tmp"' EXIT
cp idl/realize_escrow.json "$idl_tmp/idl.json"
cp packages/realize-solana/src/idl.json "$idl_tmp/client-idl.json"
anchor idl build -p realize_escrow --skip-lint --out "$idl_tmp/anchor-idl.json" -- --no-default-features --features devnet
cmp "$idl_tmp/anchor-idl.json" idl/realize_escrow.json
cargo run -p escrow-idl --locked
cmp "$idl_tmp/idl.json" idl/realize_escrow.json
cmp "$idl_tmp/client-idl.json" packages/realize-solana/src/idl.json
npm run build --workspace @vox/protocol
npm run build --workspace @vox/realize-solana
npx vitest run tests/realize-escrow-client.test.ts tests/protocol.test.ts
npx tsx scripts/test-realize-escrow-local-validator.ts
