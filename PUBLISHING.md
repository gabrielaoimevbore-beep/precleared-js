# Publishing `precleared` to npm

Steps for publishing this package under your own npm account. The owner publishes, not the assistant that built the package: nothing here has been run, no account was signed in to and nothing has been uploaded. On 17 October 2026 the name `precleared` was free on npm (`npm view precleared` returned 404), and so was `@precleared/sdk`, kept in reserve.

## 0. One-off account setup

1. Create an account at https://www.npmjs.com/signup and turn on two-factor authentication (Settings, Two-Factor Authentication). npm requires 2FA or a granular token for publishing.
2. On the machine you publish from, sign in:

   ```bash
   npm login
   ```

   `npm whoami` should print your username. If you would rather not sign in interactively, create a granular access token at https://www.npmjs.com/settings/~/tokens with publish rights and put it in `~/.npmrc` as `//registry.npmjs.org/:_authToken=<token>`. Keep tokens out of the repository.

## 1. Check the version

The version lives in two places and must match (the tests check this):

- `package.json`: `"version": "0.1.0"`
- `src/version.ts`: `export const VERSION = "0.1.0"`

npm never lets you publish the same version twice, so bump both before every release and add a line to `CHANGELOG.md`.

## 2. Check everything from a clean install

```bash
npm ci
npm run check
```

`npm run check` runs the type-check, the tests against zod 4 and the zod 3 API, the build and the smoke test of the built files. `prepublishOnly` runs the same command, so `npm publish` refuses to upload a broken build.

## 3. Look at what will be uploaded

```bash
npm pack --dry-run
```

Expect `dist/` (ESM `.js`, CommonJS `.cjs`, `.d.ts` and `.d.cts` files with source maps), `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`. `src/`, `test/`, `scripts/` and the configs are not included.

## 4. Publish

```bash
npm publish --access public
```

`--access public` is required the first time for a scoped name and harmless for an unscoped one. With 2FA on, npm asks for a one-time code. Then confirm:

```bash
npm view precleared name version dist-tags
mkdir /tmp/try && cd /tmp/try && npm init -y >/dev/null && npm install precleared zod
node -e "const { Precleared } = require('precleared'); console.log(new Precleared())"
node --input-type=module -e "import { Precleared } from 'precleared'; console.log(new Precleared())"
```

Both lines should print `Precleared { baseUrl: 'https://precleared.dev', apiKey: none }`. The package page will be https://www.npmjs.com/package/precleared.

## 5. Tag the release

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 6. Publishing from GitHub Actions instead (optional, recommended once the code is on GitHub)

npm trusted publishing lets a workflow upload without a long-lived token and adds provenance to the package page.

1. Publish 0.1.0 once by hand (step 4), or create the package first, because trusted publishing is configured per package.
2. On npmjs.com, open the package, Settings, Trusted Publisher, and add GitHub Actions with the repository `gabrielaoimevbore-beep/precleared-js` and the workflow file name `publish.yml`.
3. Add `.github/workflows/publish.yml`:

   ```yaml
   name: Publish to npm
   on:
     release:
       types: [published]
   jobs:
     publish:
       runs-on: ubuntu-latest
       permissions:
         contents: read
         id-token: write
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 22
             registry-url: https://registry.npmjs.org
         - run: npm ci
         - run: npm run check
         - run: npm publish --access public --provenance
   ```

4. Publish a GitHub release tagged `v0.1.1` (or the next version). The workflow builds, tests and uploads; no token is stored anywhere.

## 7. Next releases

1. Bump the version in `package.json` and `src/version.ts`, and note the change in `CHANGELOG.md`.
2. `npm ci && npm run check`.
3. `npm publish --access public`, or publish a GitHub release if step 6 is set up.
4. Tag the release.

## 8. If the name is taken by the time you publish

Do not rename on the fly. Check `npm view precleared` first. If it is taken, the fallback is the scoped name `@precleared/sdk`: create the `precleared` organisation at https://www.npmjs.com/org/create, change `"name"` in `package.json` to `@precleared/sdk`, update the import paths in `README.md`, and publish with `--access public` (scoped packages are private by default).
