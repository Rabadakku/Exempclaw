# Releasing Exempclaw

## Release a new version

1. `npm version minor` (or `patch`) — bumps `package.json` and creates a git tag.
   - Also update the hardcoded version in `src/index.ts` (`.version("…")`) to match.
2. `npm run build && npm test && npm run typecheck` — all must pass.
3. `npm publish` (first time: `npm publish --access public`; needs `npm login`).
4. Verify: `npx exempclaw@latest --version`.

## Update the Homebrew tap

One-time setup: create a public GitHub repo `santanajb03/homebrew-tap` with a
`Formula/` folder.

Each release:

1. Get the tarball hash:
   ```bash
   curl -sL https://registry.npmjs.org/exempclaw/-/exempclaw-<version>.tgz | shasum -a 256
   ```
2. Copy `packaging/homebrew/exempclaw.rb` into the tap repo as
   `Formula/exempclaw.rb`, updating `url` (new version) and `sha256` (step 1).
3. Commit and push the tap repo.
4. Verify:
   ```bash
   brew install santanajb03/tap/exempclaw && exempclaw --version
   ```
   (use `brew reinstall` / `brew upgrade` on subsequent releases.)

Users then install with: `brew install santanajb03/tap/exempclaw`.

## Notes

- Homebrew **core** (the default `brew install exempclaw` with no tap) requires
  notability thresholds a new project won't meet yet — a personal tap is the
  right move now, core later.
- CI automation for the publish + tap bump is out of scope for v0.4; this is a
  manual runbook.
