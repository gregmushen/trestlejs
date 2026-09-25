# Beta candidate testing ledger

**Candidate:** `0.1.0-beta.1`

**Basis:** published `0.1.0-alpha.135` framework and merged canary PR #14

**Decision:** prerelease for evaluation, not a production-readiness claim

This ledger describes observed evidence, not the full intended v1 architecture.
Passing local tests do not prove a hosted integration. `not tested` means there
is no end-to-end evidence for the named path; it does not mean the path is broken.
The beta prerelease remains on the npm `next` channel, not `latest`.

## Verified at the alpha.135 basis

| Path | Evidence and limit |
| --- | --- |
| Package publication | [Alpha 135 publish workflow](https://github.com/gregmushen/trestlejs/actions/runs/36081898885) published `@trestlejs/core`, `trestlejs`, and `create-trestlejs` at `0.1.0-alpha.135`. |
| Generated-project local checks | The same release workflow passed framework checks, a clean generated project, PostgreSQL and Chromium. It did not validate production deployment. |
| Published adjacent upgrade | The Alpha 135 release workflow passed the `0.1.0-alpha.133` → `0.1.0-alpha.134` rehearsal. The beta release gate separately rehearses `0.1.0-alpha.134` → `0.1.0-alpha.135`; neither is an upgrade *to* beta.1. |
| Isolated preview | [Canary PR #14](https://github.com/gregmushen/trestlejs-canary/pull/14) was **merged**. Its [preview run](https://github.com/gregmushen/trestlejs-canary/actions/runs/36083135433) passed site and authenticated product browser tests without sending email. |
| Hosted staging | The [post-merge staging run](https://github.com/gregmushen/trestlejs-canary/actions/runs/36083495603) deployed the site, app, and Worker and passed two non-sending browser tests. That workflow subsequently stopped in production readiness; it is not a successful production deployment. |

## Open items

| Classification | Item | Evidence boundary / next proof |
| --- | --- | --- |
| **External prerequisite** | Production deployment | The post-merge canary run stopped at read-only Doctor, before production provisioning: production Resend webhook/sender and live Stripe publishable key, price mapping, and return URL were incomplete. Configure these deliberately, rerun Doctor, then deploy and smoke-test the exact reviewed commit. No production deployment is claimed. |
| **Not tested** | Hosted Article RLS | The staging canary does not declare `Article`. Generated local PostgreSQL RLS tests are useful but cannot prove deployed Article isolation. Generate Article in a dedicated canary, migrate the hosted database, and exercise two tenants through the Worker and restricted runtime role. An unpublished Article experiment is parked; it is not part of this candidate. |
| **Not tested** | Live Resend delivery | Automatic preview/staging gates intentionally send no email. A small opt-in real-delivery test, including recipient redirection, remains. **External prerequisite:** restore sufficient Resend quota before the opt-in test; do not run bulk/repeated sends. |
| **Not tested** | Deployed async and recovery | The deployed outbox → Queue → consumer, Workflow retry, R2 signed access, and restore/reconciliation scenarios lack complete end-to-end evidence. Unit and generated local tests do not close this gap. |
| **Known defect** | Intermittent Cloudflare Pages 522s | Isolated preview runs observed transient 522 responses soon after deployment. A bounded smoke retry mitigates startup transients but does not establish sustained reliability or remove the underlying intermittent response. |
| **Not tested** | Sustained Worker reliability | Repeated/concurrent deployed requests, including auth and database operations under load, have not been measured long enough to establish reliability. |
| **Not tested** | Optional admin staging deployment | The optional admin path has not had its first isolated hosted deployment and access-control run. It is not covered by the standard canary's successful browser checks. |
| **Not tested** | Production promotion and beta upgrade | Canary PR #14 is merged, so it is **not** an open promotion PR. Exact-commit production promotion is blocked by the production prerequisites above. The final published `alpha.135` → `beta.1` generated-project upgrade must be rehearsed after beta.1 is published; prepublication CI cannot install an unpublished beta package from npm. |

## Release interpretation

`0.1.0-beta.1` is suitable for opt-in evaluation of its tested local,
preview, and staging paths. It is **not** evidence that production providers,
hosted Article isolation, live email, async/recovery, admin hosting, or
sustained availability have passed. Do not promote the `next` dist-tag to
`latest`, or describe this candidate as production-ready, until those gaps are
resolved or explicitly accepted for a narrower release.

After publication, add the beta release workflow and canary run links here.
