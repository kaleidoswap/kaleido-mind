# Publishing

The repository is public: <https://github.com/kaleidoswap/kaleido-mind>.
Two packages are published to npmjs.org under the `@kaleidorg` scope:

| Package | Source | Workflow |
|---|---|---|
| `@kaleidorg/mind` | `packages/core` | `.github/workflows/publish-npm.yml` |
| `@kaleidorg/mind-provider` | `apps/provider` | `.github/workflows/publish-provider.yml` |

`apps/cli`, `apps/playground` and `examples/*` are private and never published.

## How a release happens

Both workflows run on every push to `main` that touches their package. They
publish only when the `version` in that package's `package.json` is not on npm
yet, so a normal merge is a no-op. **Bumping a version and merging to `main`
publishes it.** The workflows use the `NPM_TOKEN` repository secret. Core is
published with provenance.

1. Bump `packages/core/package.json` (and `apps/provider/package.json` when the
   sidecar changed; its `@kaleidorg/mind` dependency is `workspace:^` and is
   rewritten to the released range by `pnpm publish`).
2. Keep `.claude-plugin/plugin.json` `version` in step with core: Claude Code
   uses it to detect plugin updates.
3. Move the `[Unreleased]` notes in `CHANGELOG.md` under the new version.
4. Open a PR, let CI pass, then merge. The workflows publish.
5. Optionally tag the merge commit (`git tag v0.7.0 && git push origin v0.7.0`).

## Publishing by hand

You only need this if the workflows are unavailable. You must be logged in to
npm with publish rights on `@kaleidorg`.

```bash
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm test

cd packages/core && npm publish --access public
cd ../../apps/provider && pnpm publish --access public --no-git-checks
```

Use `pnpm publish` for the provider (not `npm publish`) so `workspace:^` is
replaced with a real version range.

Before publishing, check the tarball contents with `npm pack --dry-run`. Core
ships `dist/`, `src/`, `skills/`, `scripts/` (the skill bundler), `README.md`
and `LICENSE`.

## Consuming a local checkout

To iterate on the engine together with a host app without publishing, point
the host at the checkout:

```jsonc
// host package.json
"@kaleidorg/mind": "file:../kaleido-mind/packages/core"
```

Run `pnpm --filter @kaleidorg/mind build` (or `tsc --watch` in
`packages/core`) after each change. React Native hosts also need to re-run
their skill bundling step.
