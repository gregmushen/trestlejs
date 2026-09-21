# Publishing TrestleJS

TrestleJS publishes three public npm packages from this workspace:

1. `@trestlejs/core`
2. `trestlejs`
3. `create-trestlejs`

All packages use one version. Prerelease versions publish under the `next`
distribution tag; stable versions publish under `latest`.

## First release

The first release bootstraps the packages before npm trusted publishing can be
configured.

1. Create or confirm the `trestlejs` organization on npm.
2. Sign in locally with an npm account that can publish under that scope.
3. Run `pnpm check`, `pnpm release:check`, and `pnpm release:pack`.
4. Inspect the three archives in `release/`.
5. Publish them in dependency order:

   ```bash
   npm publish ./release/trestlejs-core.tgz --access public --tag next
   npm publish ./release/trestlejs.tgz --access public --tag next
   npm publish ./release/create-trestlejs.tgz --access public --tag next
   ```

## Trusted publishing

After the first release, configure the trusted publisher for each package on
npmjs.com with:

- provider: GitHub Actions
- organization or user: `gregmushen`
- repository: `trestlejs`
- workflow filename: `publish.yml`
- environment: `npm`
- allowed action: direct publish

No npm token is stored in GitHub. The workflow exchanges GitHub's OIDC identity
for a short-lived npm credential and publishes provenance automatically.

Once trusted publishing succeeds, configure each package to require two-factor
authentication and disallow traditional tokens.

## Subsequent releases

Update all three package versions and `TRESTLEJS_VERSION`, run the release
checks, commit the change, then push a matching tag:

```bash
pnpm check
pnpm release:check
pnpm release:pack
git tag v0.1.0-alpha.1
git push origin main v0.1.0-alpha.1
```

The tag must exactly match the package version after removing its leading `v`.
