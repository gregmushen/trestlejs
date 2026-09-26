# Beta candidate testing ledger

**Candidate:** `0.1.0-beta.3` for `trestlejs` and `create-trestlejs`

**Basis:** published `0.1.0-beta.3` CLI/creator, the standard canary at its
earlier alpha.135 basis, and a separate admin-enabled canary at alpha.90

**Decision:** prerelease for evaluation, not a production-readiness claim

This ledger describes observed evidence, not the full intended v1 architecture.
Passing local tests do not prove a hosted integration. `not tested` means there
is no end-to-end evidence for the named path; it does not mean the path is broken.
The CLI and creator beta prerelease remain on npm `next`, not `latest`.
`@trestlejs/core` remains at `0.1.0-beta.1` on `next`; do not infer that all
packages share the CLI's beta.3 version.

## Verified at the alpha.135 basis

| Path | Evidence and limit |
| --- | --- |
| Package publication | [Alpha 135 publish workflow](https://github.com/gregmushen/trestlejs/actions/runs/36081898885) published `@trestlejs/core`, `trestlejs`, and `create-trestlejs` at `0.1.0-alpha.135`. |
| Generated-project local checks | The same release workflow passed framework checks, a clean generated project, PostgreSQL and Chromium. It did not validate production deployment. |
| Published adjacent upgrade | The Alpha 135 release workflow passed the `0.1.0-alpha.133` → `0.1.0-alpha.134` rehearsal. The beta release gate separately rehearses `0.1.0-alpha.134` → `0.1.0-alpha.135`; neither is an upgrade *to* beta.1. |
| Isolated preview | [Canary PR #14](https://github.com/gregmushen/trestlejs-canary/pull/14) was **merged**. Its [preview run](https://github.com/gregmushen/trestlejs-canary/actions/runs/36083135433) passed site and authenticated product browser tests without sending email. |
| Hosted staging | The [post-merge staging run](https://github.com/gregmushen/trestlejs-canary/actions/runs/36083495603) deployed the site, app, and Worker and passed two non-sending browser tests. That workflow subsequently stopped in production readiness; it is not a successful production deployment. |

## Beta release evidence

The [beta release workflow](https://github.com/gregmushen/trestlejs/actions/runs/36084890295)
passed framework tests, PostgreSQL-backed `alpha.134` → `alpha.135`
upgrade rehearsal, clean generated-project checks, package build, and
publication. Public npm metadata confirms `@trestlejs/core`, `trestlejs`,
and `create-trestlejs` at `0.1.0-beta.1` on the `next` dist-tag; `latest`
was unchanged. The published `npx create-trestlejs@next --help` entry point
ran successfully. This is package/release evidence, not a beta.1 hosted
deployment or a published `alpha.135` → `beta.1` upgrade rehearsal.

The [beta.3 publish run](https://github.com/gregmushen/trestlejs/actions/runs/36167302856)
passed its verification and npm publish jobs. npm metadata confirms
`trestlejs` and `create-trestlejs` at beta.3 on `next`, with `latest` still at
alpha.5. The existing-project admin enablement and SetupPlan fixes are in the
published CLI, but a successful upgrade of the alpha.90 admin canary to
beta.3 has **not** been demonstrated.

The `check:beta-upgrade` CI gate separately creates a pristine project from
published beta.1, installs published beta.3, reviews the exact append-only
migration tail and backup-verify opt-in, then checks source parity, two
unchanged tenant records, and forced PostgreSQL RLS. This is published-package
upgrade evidence for that clean project; it is not evidence that an edited
alpha.90 admin canary can be upgraded automatically.

## Separate admin-enabled canary evidence

[Platform canary PR #1](https://github.com/gregmushen/trestlejs-platform-canary/pull/1)
was merged. Its [isolated preview run](https://github.com/gregmushen/trestlejs-platform-canary/actions/runs/36209362117)
deployed an isolated Worker, Pages projects, and a Neon branch, then passed
non-sending smoke and site-browser checks. The
[post-merge staging run](https://github.com/gregmushen/trestlejs-platform-canary/actions/runs/36209805920)
passed database-role checks, admin Worker and Pages deployment, operational
smoke, and two browser tests. The admin browser test proved that the sign-in
screen loads, an anonymous request cannot read the platform session, admin
sign-up is absent, and a protected page redirects to sign-in. It did **not**
authenticate an operator or test a support session. Production was skipped by
the workflow's explicit promotion gate. Automatic staging checks sent no
Resend email.

That canary's generated source still uses alpha.90. These runs prove a hosted
admin deployment and anonymous access boundary for that version, not beta.3
hosting or the newer read-only support-view handoff merged in
[TrestleJS PR #192](https://github.com/gregmushen/trestlejs/pull/192).

## Open items

| Classification | Item | Evidence boundary / next proof |
| --- | --- | --- |
| **External prerequisite** | Production deployment | The post-merge canary run stopped at read-only Doctor, before production provisioning: production Resend webhook/sender and live Stripe publishable key, price mapping, and return URL were incomplete. Configure these deliberately, rerun Doctor, then deploy and smoke-test the exact reviewed commit. No production deployment is claimed. |
| **Preview verified; staging pending** | Hosted Article RLS | [Canary PR #15](https://github.com/gregmushen/trestlejs-canary/pull/15) (open, **not merged**) generated `Article` with the canary's pinned **alpha.135** CLI, not beta.3. At head `fb2a62c`, the [isolated preview run](https://github.com/gregmushen/trestlejs-canary/actions/runs/36213413798) migrated a fresh Neon branch, deployed the Worker and Pages, and passed three deployed Chromium tests without sending email. Two separately authenticated users each created an organization and Article rows through the deployed Worker API. The test asserted that each tenant lists only its own rows and that cross-tenant `GET`/`PATCH`/`DELETE` by id return 404. Forged tenant headers were refused. Refused writes left the victim rows unchanged, and owner update/delete still worked. An out-of-band step with the Worker's exact runtime credential then proved several points. The credential is the configured restricted login: no superuser, no BYPASSRLS, not the table owner. It is denied direct `article` access, and as `trestle_app` it reads 0 rows without a tenant context. Scoped to a tenant, it sees only that tenant's rows; cross-tenant UPDATE and DELETE affect 0 rows, and cross-tenant INSERT is rejected. `article` forces RLS and stores the Worker-created rows under their creating organization. Limits: beta.3 was not used. With the canary source recorded at alpha.128, `upgrade plan` requires `template-source` manual review, and the beta.3 generator's tenant-scoped event consumers do not typecheck against that source. The beta.3 Article migration differs only by an added `UNIQUE(organization_id, id)`. **Staging evidence follows the owner merging PR #15.** Even then, the automatic staging gate does not exercise Article; the existing staging Article probe is in the opt-in live-email spec. |
| **Not tested** | Live Resend delivery | Automatic preview/staging gates intentionally send no email. A small opt-in real-delivery test, including recipient redirection, remains. **External prerequisite:** restore sufficient Resend quota before the opt-in test; do not run bulk/repeated sends. |
| **Not tested** | Deployed async and recovery | The deployed outbox → Queue → consumer, Workflow retry, R2 signed access, and restore/reconciliation scenarios lack complete end-to-end evidence. Unit and generated local tests do not close this gap. |
| **Known defect** | Intermittent Cloudflare Pages 522s | Isolated preview runs observed transient 522 responses soon after deployment. A bounded smoke retry mitigates startup transients but does not establish sustained reliability or remove the underlying intermittent response. |
| **Not tested** | Sustained Worker reliability | Repeated/concurrent deployed requests, including auth and database operations under load, have not been measured long enough to establish reliability. |
| **Not tested** | Authenticated admin and support-view staging | The alpha.90 admin canary has passed hosted anonymous-denial checks, but no deployed operator sign-in, privileged action, support-session entry/exit, or read-only customer-app support view has passed. Upgrade or regenerate an isolated admin canary from the published beta, bootstrap an operator, and test those paths without a real-user email send. |
| **Not tested** | Production promotion and older admin-canary upgrade | Both canary PRs are merged; neither is an open promotion PR. Exact-commit production promotion remains blocked by the production prerequisites above. The clean published beta.1 → beta.3 upgrade has a PostgreSQL-backed gate; the alpha.90 admin canary still reports `template-source` manual review and has not been migrated to beta.3. |

## Release interpretation

`0.1.0-beta.3` is suitable for opt-in evaluation of the CLI/creator and their
tested paths. The separate alpha.90 admin canary establishes limited hosted
admin evidence; it does **not** validate beta.3 admin operation. Neither is
evidence that production providers, hosted Article isolation, live email,
async/recovery, authenticated admin support access, or sustained availability
have passed. Do not promote the `next` dist-tag to
`latest`, or describe this candidate as production-ready, until those gaps are
resolved or explicitly accepted for a narrower release.
