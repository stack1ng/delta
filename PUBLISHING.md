# Publishing `@stack1ng/delta`

Releases publish only from GitHub Actions on a `v*` tag, using npm
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) and OIDC.
There is no `NPM_TOKEN`: the workflow receives a short-lived, workflow-bound
credential and npm generates provenance for the public package from the public
repository.

These identifiers are part of the trust boundary and must match exactly:

- npm package: `@stack1ng/delta`
- public GitHub repository: `stack1ng/delta`
- workflow filename: `release.yml`
- GitHub environment: `Production`

This standalone repository name is intentional even though the package belongs
to the broader Pyro project. The repository did not exist when this wiring was
prepared; creating it and configuring external settings are separate bootstrap
steps, not actions performed by the release scripts.

## First-release bootstrap

npm Trusted Publishing can be configured only after the package already exists.
At the time this workflow was added, `@stack1ng/delta` was not present in the public
registry. Bootstrap `0.1.0` once with an interactive maintainer session—never a
CI or long-lived automation token:

1. Create the **public** `stack1ng/delta` repository, push this history,
   and confirm `package.json` still names that exact repository.
2. Confirm the maintainer can publish public packages in the npm `@stack1ng` scope
   and has npm two-factor authentication configured.
3. From a clean checkout, enter `nix develop` and run:

   ```sh
   bun install --frozen-lockfile
   bun run ci
   npm pack --pack-destination /tmp
   npm login
   npm publish /tmp/stack1ng-delta-0.1.0.tgz --access public
   npm logout
   ```

   Inspect the `npm pack` manifest before publishing. Do not push a `v0.1.0`
   tag afterward: that version was published manually and the tag workflow
   would correctly fail rather than overwrite it.
4. On npm, open `@stack1ng/delta` → Settings → Trusted Publisher and configure:
   GitHub owner `stack1ng`, repository `delta`, workflow `release.yml`,
   environment `Production`, allowed action **npm publish**.
5. On GitHub, create the `Production` environment and restrict deployment tags
   to `v*` (and add required reviewers if desired).
6. After the OIDC release path is confirmed, set npm publishing access to
   require 2FA and disallow traditional tokens. Do not add an `NPM_TOKEN`
   secret to GitHub.

The manual npm login is only the package-creation bootstrap. Log out afterward;
all later releases use OIDC.

## Later releases

Work from a clean checkout and enter the pinned dev shell:

```sh
nix develop
npm run release
```

The release driver asks for an explicit version or `patch`, `minor`, or `major`.
`npm version` then runs `bun install --frozen-lockfile && bun run ci`, prompts for
changelog bullets, creates the version commit and `v<version>` tag, and pushes
the tag. It does not publish from the workstation.

For an alpha prerelease, run `npm run alpha`; prerelease versions publish on the
`alpha` dist-tag rather than `latest`.

The tag triggers `.github/workflows/release.yml` in the `Production`
environment. That job uses a GitHub-hosted runner, rebuilds all four WASM
artifacts through the canonical Nix/Bun CI route, requires the tag to equal
`v<package.json version>`, packs and inspects the exact tarball, and publishes
that tarball with npm provenance over OIDC.

OIDC itself cannot be exercised locally. Watch the first tagged run and verify
the npm provenance links back to `stack1ng/delta` and `release.yml`.
