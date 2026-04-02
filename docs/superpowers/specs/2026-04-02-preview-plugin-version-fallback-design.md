# Preview Plugin Version Fallback Design

## Summary

Preview CLI builds should not try to install preview-tagged versions of `@opencode-ai/plugin`.

Today, config dependency installation uses `Installation.VERSION` directly, so a CLI built as `1.3.8-preview.202604021601` writes and checks `@opencode-ai/plugin@1.3.8-preview.202604021601`. That package version is not published, which causes plugin install warnings during startup.

This change keeps the CLI preview version intact while changing only config-installed plugin dependency resolution:

- local builds keep current wildcard and `latest` semantics
- stable builds keep exact version pinning
- preview builds resolve `@opencode-ai/plugin` to the previous stable patch version
- if preview parsing fails, fall back to `latest`

## Problem

`packages/opencode/src/config/config.ts` currently uses `Installation.VERSION` directly in two places:

- `installDependencies()` writes `@opencode-ai/plugin` into a generated `package.json`
- `needsInstall()` compares the existing dependency version against the same target

That is correct for stable builds, but wrong for preview builds. Preview CLI binaries encode a preview version for the CLI itself, not for every dependent package. Since `@opencode-ai/plugin` is not published at those preview versions, config bootstrap emits avoidable install failures.

## Goals

- Stop preview CLI builds from requesting unpublished preview plugin versions.
- Keep stable builds pinned to the matching stable plugin version.
- Preserve current local-build behavior.
- Keep install/write and stale-check logic aligned by sharing one resolver.
- Fail open to `latest` rather than throwing if preview parsing is malformed.

## Non-Goals

- Changing `Installation.VERSION` itself.
- Changing build-time version generation in `packages/script`.
- Changing plugin compatibility checks.
- Generalizing dependency version policy beyond `@opencode-ai/plugin` in this pass.

## Approach

### 1. Resolve plugin dependency target in one place

Add a small helper in `packages/opencode/src/config/config.ts` that resolves the dependency target for `@opencode-ai/plugin`.

The helper should be explicit and pure. It should take the current version string and local-build flag as inputs rather than reading module-level globals internally. For example, it can accept:

- `version: string`
- `local: boolean`
- `kind: "install" | "check"`

The helper should support two closely related modes because the existing code treats local development specially:

- install/write target
- comparison/update target

Behavior:

- local build:
  - install/write target: `*`
  - comparison/update target: `latest`
- stable build like `1.3.7`:
  - both targets: `1.3.7`
- preview build like `1.3.8-preview.202604021601`:
  - both targets: `1.3.7`
- malformed preview version or failed decrement:
  - both targets: `latest`

The helper should be pure, local, and defensive.

Detection should be version-string based inside this helper, not `Installation.isPreview()`. The reason is that the fallback policy depends on whether the version string can be safely reversed from a preview form to a previous stable version. `Installation.isPreview()` is channel-based and useful elsewhere, but it does not by itself tell us whether a specific version string can be parsed and decremented safely.

The expected preview format is the one currently produced by `packages/script/src/version.ts`:

- stable base `1.3.7`
- preview result `1.3.8-preview.<stamp>`

The helper should strip the prerelease suffix, parse the stable core, and decrement the patch by one. If the version does not match that expectation or patch decrement would be invalid, return `latest`.

### 2. Wire installDependencies() through the resolver

`installDependencies()` should stop writing `Installation.VERSION` directly.

Instead it should resolve the install/write target and write:

- `@opencode-ai/plugin: "*"` for local builds
- `@opencode-ai/plugin: "1.3.7"` for stable or preview-derived stable builds
- `@opencode-ai/plugin: "latest"` only when preview fallback is required

This is the user-visible fix for the current preview install warnings.

### 3. Wire needsInstall() through the same resolver

`needsInstall()` should use the same resolver so install intent and stale-check behavior remain consistent.

That means:

- local build still uses the current `latest` branch with `PackageRegistry.isOutdated(...)`
- stable and preview-derived-stable targets use exact equality checks
- malformed preview versions fall into the `latest` branch rather than forcing repeated exact-version mismatches

The dual-mode helper exists only to preserve the current local behavior difference:

- local install writes `*`
- local stale-check compares against `latest`

For stable and preview-derived-stable builds, both modes resolve to the same exact version string.

## Data Flow

### Stable build

- `Installation.VERSION = 1.3.7`
- resolver returns `1.3.7`
- config package writes `@opencode-ai/plugin: 1.3.7`
- `needsInstall()` compares against `1.3.7`

### Preview build

- `Installation.VERSION = 1.3.8-preview.<stamp>`
- resolver derives previous stable patch `1.3.7`
- config package writes `@opencode-ai/plugin: 1.3.7`
- `needsInstall()` compares against `1.3.7`

### Malformed preview build

- `Installation.VERSION` cannot be safely parsed as preview semver
- resolver returns `latest`
- config package writes `@opencode-ai/plugin: latest`
- `needsInstall()` uses the existing online/outdated flow

## Error Handling

- Preview parsing must not throw into config bootstrap.
- If semver parsing or patch decrement fails, return `latest`.
- Keep this failure mode quiet and functional rather than turning a dependency policy issue into a boot failure.
- Do not add warning logs for this fallback in this pass. Silent functional fallback is preferred over extra startup noise.

## Testing Strategy

Follow TDD.

Add focused tests in `packages/opencode/test/config/config.test.ts` to cover:

- stable build writes the exact stable plugin version
- preview build writes the previous stable patch version
- malformed preview build falls back to `latest`
- `needsInstall()` uses the resolved plugin target instead of the raw preview CLI version

Because `Installation.VERSION` is not convenient to replace directly in these tests, the resolver helper should be directly unit-testable with explicit inputs. Then add one narrow integration-style config test proving `installDependencies()` or `needsInstall()` is wired through that helper rather than duplicating raw-version logic.

Tests should stay narrow and avoid changing unrelated config-install behavior.

## Risks

- deriving the wrong stable version for preview builds if the preview format assumption is wrong
- writing `latest` too often if the fallback path is too broad
- letting install and stale-check behavior drift if the resolver is duplicated

## Mitigations

- keep one shared resolver in `config.ts`
- key preview handling off the actual semver string rather than ad hoc string slicing alone
- test both write-path and stale-check-path behavior

## Expected Outcome

- preview CLI binaries keep their `-preview` version
- config-installed `@opencode-ai/plugin` no longer requests unpublished preview package versions
- preview builds prefer the previous stable patch plugin release
- malformed preview version strings degrade to `latest` instead of failing bootstrap

## Notes

This design is intentionally limited to config dependency installation for `@opencode-ai/plugin`.
