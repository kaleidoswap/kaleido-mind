# Publishing `@kaleidorg/mind`

The repo is private: **https://github.com/kaleidoswap/kaleido-mind**.

During active development, consumers (rate, desktop-app) link the package
locally via `file:` — fastest iteration, no republish needed:

```jsonc
// rate/package.json
"@kaleidorg/mind": "file:../kaleido-mind/packages/core"
```

To consume it as a *versioned* npm package (CI, external consumers, release
builds), publish it to one of two registries. Both need a one-time auth step
you must run yourself.

---

## Option A — GitHub Packages (recommended for a private package)

Ties the package to the private repo; no separate npm org needed.

**One-time:**
1. The package scope must match the repo owner, so rename the package
   `@kaleidorg/mind` → `@kaleidoswap/mind` (and update the 3 import sites in
   rate: `package.json`, `services/QVACService.ts`, `screens/AIAssistantScreen.tsx`).
2. Add to `packages/core/package.json`:
   ```jsonc
   "publishConfig": { "registry": "https://npm.pkg.github.com" }
   ```
3. Authorize the token for package publishing (current `gh` token lacks it):
   ```bash
   gh auth refresh -s write:packages,read:packages
   ```

**Publish:**
```bash
cd kaleido-mind/packages/core
pnpm build
npm publish
```

**Consume** (in rate / desktop-app), add `.npmrc`:
```
@kaleidoswap:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```
then `"@kaleidoswap/mind": "^0.0.1"`.

---

## Option B — public npmjs.org

Simpler tooling, but the package is public (the source repo can stay private).

**One-time:**
```bash
npm login                     # authenticate (currently 401 — not logged in)
```
The `@kaleido` scope must be owned by your npm account/org (or rename to a
scope you own).

**Publish:**
```bash
cd kaleido-mind/packages/core
pnpm build
npm publish --access public
```

**Consume:** `"@kaleidorg/mind": "^0.0.1"` — no `.npmrc` needed.

---

## Recommendation

- **Keep the `file:` link for local dev** — instant iteration while we're
  actively building. No publish loop.
- **Publish to GitHub Packages (Option A) at milestones** so CI and other
  surfaces install a pinned version.
- Add a `release` GitHub Action (publish on `v*` tag) once the registry is
  chosen, so versioning is automated.

## Versioning

`packages/core` is the publishable unit. Bump `version` there per release.
`apps/provider` stays private (`"private": true`) — it's an internal sidecar,
not published.
