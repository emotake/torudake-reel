# Dependency risk register

## `image-size` 2.0.2 (temporary acceptance)

- Status: accepted temporarily; review no later than 2026-09-13.
- Advisories:
  - [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
  - [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)
- Current upstream state (checked 2026-08-13): npm publishes `image-size`
  2.0.2 as the latest version. The advisories currently list no available
  patched version, despite some audit output referring to 2.0.3.
- Dependency path: `vinext@0.0.50 -> image-size@2.0.2`. Vinext is a
  development dependency used for local development and builds.
- Exposure: the package is absent from `dist/server`, `dist/client`, and the
  deployed `dist/cloudflare-pages/_worker.js`. It is not reachable from a
  production request. During a build it sees only repository-controlled image
  files; users cannot upload an ICNS, JXL, or HEIF file to this build path.
- Verification: `pnpm audit --prod --audit-level high` reports no known
  production vulnerabilities. The complete test suite, lint, typecheck, and
  Cloudflare Pages build pass with the other patched transitive overrides.
- Compensating controls: do not add untrusted or externally downloaded images
  to the repository/build input without review. Keep CI/build workers bounded
  by normal time and memory limits.
- Exit condition: upgrade `image-size` (normally through Vinext) as soon as a
  patched upstream release is published, then remove this acceptance after the
  full validation suite passes. Recheck the advisory and npm registry by the
  review date even if no release notification arrives.

This acceptance covers only the two denial-of-service advisories above. It
does not waive newly disclosed vulnerabilities or production dependencies.
