# `@vox/realize-contracts`

Standalone, versioned Realize schemas, validators, TypeScript types, and provider handoff for VOX and independent generation providers. It is generated from the canonical `@vox/protocol` source and can be installed without access to the broader VOX repository.

The package exports the Realize v1 runtime contract from its root, the JSON Schema at `@vox/realize-contracts/schemas/realize-v1.schema.json`, examples under `@vox/realize-contracts/fixtures/realize/`, OpenAPI at `@vox/realize-contracts/openapi.json`, and the Populi handoff at `@vox/realize-contracts/handoff.md`.

## Build and release

From the VOX monorepo:

```sh
npm run build --workspace @vox/realize-contracts
npm pack --workspace @vox/realize-contracts
```

The build regenerates the JSON Schema and OpenAPI from the canonical Zod contracts and copies runtime modules, declarations, and fixtures into the standalone package. The package build fails if its version differs from `@vox/protocol`. Change the protocol source first, regenerate and review the package, then release both on the same version. Publishing is restricted to the `@vox` package scope; configure the organization's private npm registry and CI credentials before release.

Consumers pin an exact version, for example:

```sh
npm install --save-exact @vox/realize-contracts@1.0.0
```

The published artifact contains no VOX application credentials, payment adapters, or transaction implementation. A protocol breaking change requires a new `realize/N` wire version and coordinated package major version.
