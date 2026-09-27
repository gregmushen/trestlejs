# Jobs admin, engine choice, and email sequences

Status: proposed (Greg, 2026-09-27). Extends [JOB_RUNTIMES.md](JOB_RUNTIMES.md)
and the job runtimes plan (PRs #214–#218).

**Goal:** operators see and change the jobs engine and where it is hosted from
the platform admin, understand what each engine is good for, and build email
sequences that behave the same on every engine and stop when they should.

**Non-goals:**
- Listing or inspecting individual runs in admin. Each engine's own dashboard
  does that; admin links to it.
- A visual sequence builder. Sequences are code (`defineSequence`).
- Marketing email to people who are not users of the application.

## 1. Admin Jobs view

A new platform admin view, **Jobs**, readable by platform operators with the
operations read permission.

### What it shows

| Field | Example | Notes |
| --- | --- | --- |
| Engine | trigger.dev | `cloudflare`, `trigger`, `inngest` |
| Hosting | Self-hosted (Docker) | vendor cloud or self-hosted; Cloudflare is always Cloudflare |
| Location | `https://jobs.example.com`, `us-east-1` | instance URL and region where known |
| Support status | Experimental | per engine **and** hosting profile, from `trestle evidence`; self-hosted stays experimental until its recovery evidence is verified |
| Configuration | project ID, environment, concurrency, retries, schedules on/off | credentials show only *set* / *missing*, never values |
| Dispatch health | 3 pending, engine reachable | pending outbox rows, last dispatch receipt, reconciliation backlog |
| Open dashboard | link | trigger.dev or Inngest instance for this environment; for Cloudflare, the existing outbox and Workflow views |
| Migration | draining, 12 left | only while an engine switch is in progress |

### Editing

Settings are editable from admin. Every change requires a platform step-up and
writes an audit event (actor, before and after, never secret values).

- **Applied immediately:** project or endpoint ID, credentials (write-only),
  concurrency, retry defaults, schedules enabled.
  - Credentials are validated against the engine before they are saved.
  - For trigger.dev, saving credentials or secrets also syncs them to the jobs
    target, as `trestle secrets push --target jobs` does.
- **Engine or hosting switch** (for example Cloudflare → trigger.dev, or
  trigger.dev cloud → self-hosted): runs the same flow as
  `trestle jobs migrate`, never a bare toggle.
  1. **Plan:** inventory pending outbox rows, in-flight runs and schedules;
     check the target's credentials and reachability; show rollback steps.
  2. **Confirm:** the operator reviews the plan and confirms with step-up.
  3. **Drain and switch:** the dispatch owner changes exactly once and event
     IDs are kept, so nothing is lost or run twice.
  4. **Status:** progress shows in the Jobs view; rollback is one action while
     the previous engine's bindings are still in place.
  - An experimental target requires an explicit acknowledgement.

### Where settings live

- `.trestle/project.yaml` (`jobs: { runtime, hosting, endpoint? }`) is the
  initial default.
- Admin changes are stored in the database, per environment, and take
  precedence. `trestle status` and `doctor` show the effective settings and
  where they came from, and warn when the database and the file disagree.
- Secrets are stored in the existing encrypted credential store, not in the
  settings row.

## 2. Choosing an engine

The Jobs view and the docs explain each engine in the same terms.

| | Cloudflare (default) | trigger.dev | Inngest |
| --- | --- | --- | --- |
| Where job code runs | your Worker, Workflows | trigger.dev machines (Node), or yours if self-hosted | your Worker; Inngest calls a signed endpoint |
| Hosting | Cloudflare | trigger.dev cloud or self-hosted (Docker/K8s) | Inngest cloud or self-hosted (Cloudflare Container + Neon) |
| Best for | no extra vendor, lowest cost, light and frequent work | long or heavy jobs, Node libraries, Python scripts, many sequences | step functions and sequences while keeping Worker bindings (R2, Queues, Durable Objects) |
| Visibility | outbox and Workflow views in admin | trigger.dev dashboard | Inngest dashboard |
| Trade-offs | Worker CPU and time limits; basic tooling | separate `trestle_jobs` database login; secrets synced to the engine; Cloudflare bindings only through a signed internal route | another vendor; a signed endpoint on your Worker |

Frequent schedules are **not** a reason to leave Cloudflare on their own. Since
#202, due work runs on the scheduler Durable Object's alarm instead of a
per-minute cron: a job checked every minute uses no cron triggers, and an idle
project makes no database queries. The copy should say so. Each run still
costs Worker time, which is where heavy per-minute work favors another engine.

## 3. Built-ins on every engine

### Stripe webhooks

No new work. Stripe always calls the Worker; the handler verifies the event and
writes billing events to the outbox (`packages/db/src/billing-events.ts`); the
outbox dispatches to the active engine. Endpoint setup is already automatic
(`packages/cli/src/stripe-webhook.ts`).

- **Proof to add:** the conformance suite includes a Stripe billing event
  delivered to a handler on each engine.

### Resend

- **Webhook setup:** add automatic Resend webhook creation, matching Stripe
  (plan, apply, rotate, store the signing secret). Today only the secret's
  format is checked (`packages/cli/src/resend-status.ts`).
- **Delivery events:** bounces, complaints and delivery status are verified at
  the Worker and written to the outbox like Stripe events.
- **Sending from jobs:** Cloudflare and Inngest send from the Worker. trigger.dev
  needs the Resend key in the jobs secrets target; `doctor` and the Jobs view
  report it missing.
- **Idempotency:** every send uses a stable Resend idempotency key derived from
  the sequence run and step, so a retried step never sends twice.

### Email sequences (`defineSequence`)

```ts
export const trialNurture = defineSequence({
  id: "trial-nurture",
  authority: "tenant",
  trigger: "user.signed_up",
  exitOn: ["billing.subscription.activated", "email.unsubscribed"],
  steps: [
    { send: "welcome" },
    { wait: "3d" },
    { send: "tips", unless: (ctx) => ctx.user.activated },
    { wait: "4d" },
    { send: "trial-ending" },
  ],
});
```

Each engine compiles it to its own form:

| | Cloudflare | trigger.dev | Inngest |
| --- | --- | --- | --- |
| wait | Workflow `step.sleep` | `wait.for` | `step.sleep` |
| exit on event | outbox event cancels the Workflow instance | outbox event cancels the run | `cancelOn` / `waitForEvent` |

Rules that apply on every engine:

1. **Unsubscribe and suppression.**
   - Every sequence email has a signed one-click unsubscribe link and the
     `List-Unsubscribe` headers.
   - A suppression list (per tenant and address) is checked before every send.
     Unsubscribes, hard bounces and complaints add to it automatically.
   - Transactional email (password reset, receipts) is not suppressed by
     marketing unsubscribes; sequences declare which kind they are.
2. **Exit conditions.** `exitOn` events end the run on any engine, including
   Stripe billing events and Resend delivery events. An exit that arrives
   during a wait prevents the next send.
3. **Authority before every send.** The same re-verification as other job
   steps: tenant still exists, user still a member, entitlement still active,
   provenance inside the validity window. A failure ends the run as a
   permanent failure, not a retry.
4. **No duplicates.** Idempotent sends (above); a sequence run is keyed by
   sequence, tenant and user, so a repeated trigger does not start a second
   run.
5. **Timing.** Waits are measured in the recipient's time zone when known;
   sends that land in quiet hours (default 21:00–08:00) move to the next
   allowed time.

Admin shows, per sequence: active runs, sends, exits by reason, and
suppressions, with a link to the engine dashboard for individual runs.

## Proof

- Conformance suite, per engine: Stripe event handoff; sequence wait, exit
  during a wait, suppression before send, authority revoked between steps,
  retried send not duplicated (Resend test mode or a recorded fake at the HTTP
  boundary).
- Admin: an engine switch from the Jobs view with pending work, with no lost
  or duplicated events (reusing the #218 migration test); an audit event for
  every settings change; secrets never returned by any admin API.

## Phases

1. **Jobs view, read-only** (engine, hosting, status, config, dashboard link,
   dispatch health). Depends on #218.
2. **Editable settings and switching from admin** (database settings,
   precedence, step-up, audit, migrate flow).
3. **Resend webhooks and delivery events**, plus the Stripe conformance case.
4. **`defineSequence`** with suppression, exits, authority, idempotency and
   timing on all three engines.
5. **Sequence admin panel** and docs, including the engine comparison.

## Open questions

- Should changing hosting within the same engine (trigger.dev cloud →
  self-hosted) keep the old instance available for rollback automatically?
- Quiet hours and time zones: a per-tenant setting, per sequence, or both?
- Beyond email sequences, which other built-ins are wanted?
