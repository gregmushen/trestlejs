---
name: trestle-setup
description: Design, review, apply, and verify a new or existing TrestleJS application from product requirements. Use when a user wants to plan, scaffold, configure, or finish a TrestleJS project; do not use for an isolated routine code edit that does not change application architecture or setup.
---

# Trestle Setup

Turn product intent into a reviewed Trestle architecture and, only after explicit approval, a verified application. Supply discovery and architectural judgment; use the Trestle CLI for deterministic operations it supports.

Track the active phase explicitly:

```text
DISCOVER -> UNDERSTAND -> CLARIFY -> SHARED UNDERSTANDING
         -> DESIGN -> DESIGN REVIEW -> SETUP PLAN
         -> MUTATION REVIEW -> EXPLICIT APPROVAL
         -> APPLY -> VERIFY -> REPORT
```

## Non-negotiable boundary

Before explicit mutation approval, perform read-only work only. Do not create or edit files, install dependencies, provision resources, create or rotate secrets, run migrations, deploy, change GitHub settings or DNS, touch production, or create paid resources.

Approval must answer the concrete mutation review. Positive reactions such as “looks great” or approval of the architecture alone do not authorize mutation. If approval is ambiguous, ask directly.

Initial setup approval does not authorize production deployment, production secret changes or key rotation, destructive production migrations, production DNS changes, production deletion, or paid production resources. Obtain separate operation-specific approval for each of those.

## Discover before asking

Inspect safely available facts before questioning:

- repository and Git state, remotes, package manager, runtime, and dependencies;
- existing Trestle manifest, applications, packages, auth, database schema, migrations, and tenancy controls;
- Wrangler, Cloudflare, GitHub Actions, environment, and deployment configuration;
- tool installation and authentication status through read-only commands;
- secret names and validation status without reading values;
- current tests, builds, Doctor output, and obvious architectural conflicts.

First determine whether this is a new project or an existing project. Never replace an existing project wholesale merely because a standard template exists.

Probe the installed CLI surface with `trestle --help` and relevant subcommand help. Do not assume a command from this skill or the specification exists in the installed version.

## Understand the product

Ask what users should accomplish, then follow the dependencies in their answer. Cover only relevant areas: users, organizations, resources, workflows, artifacts, integrations, transactional email, billing, administration, asynchronous behavior, coordination, environments, delivery, cost, compliance, latency, and geography.

Ask one primary question at a time. When a genuine choice has a small answer space, offer two or three meaningful alternatives, recommend one with reasons, and permit a custom answer. Do not turn settled Trestle conventions into artificial choices.

Prefer product questions such as “what happens after submission?” over infrastructure questions such as “do you want a Queue?” Infer infrastructure from required behavior.

Explicitly discover cost constraints. Never silently select a paid resource. A paid proposal must include why it is needed, the determinable cost, free alternatives, their consequences, and an approval requirement.

## Establish shared understanding

Before architecture design, present a concise checkpoint:

- **Known:** explicitly stated or safely discovered facts.
- **Inferred:** conclusions derived from those facts.
- **Assumed:** unresolved facts currently being assumed.

Receive confirmation or corrections before proceeding. Later answers may revise earlier conclusions.

## Design incrementally

Read [references/architecture.md](references/architecture.md) before designing or reviewing architecture.

Review the design in coherent sections rather than one large reveal:

1. application surfaces and UI;
2. identity, tenancy, and authorization;
3. domain resources, data, and storage;
4. async execution and coordination;
5. administration and external integrations;
6. environments, delivery, secrets, and observability.

For material choices, show viable alternatives and a recommendation. Enable a component only when a requirement justifies it. Confirm each substantial section and update prior decisions when needed.

After the sections are reviewed, present the complete design for architecture approval. State clearly that design approval does not authorize mutation.

## Produce a SetupPlan

After design approval, construct a versioned, deterministic, serializable SetupPlan in memory. It must be diffable, resumable, free of secret values, and explicit about:

- project topology and UI stack;
- identity, tenancy, resources, providers, and integrations;
- environments, delivery, CI/CD, secrets, logging, and verification;
- paid resources, destructive intent, exclusions, and required approvals;
- the schema and minimum CLI capability versions it requires.

The proposed path is `.trestle/setup.json`. Creating or updating it is itself a mutation and must appear in mutation review unless the user explicitly requested only a plan artifact.

If `trestle plan validate` and `trestle plan diff` exist, validate the plan through standard input before persisting it and resolve all reported unsupported combinations, conflicts, blocked items, and unknowns. If they do not exist, report that capability gap. Do not pretend validation occurred, and do not invent a private schema as a substitute.

## Review exact mutations

Before applying, list:

- every file and dependency change;
- database, Cloudflare, GitHub, and other external resources;
- migrations and deployments;
- encrypted credential files, secret names, and master-key locations without values;
- destructive operations and paid resources;
- expected cost and free-tier assumptions;
- actions explicitly excluded.

Ask for a direct affirmative response to this review.

## Apply deterministically

After approval, prefer the highest-level available idempotent command, normally `trestle apply .trestle/setup.json` when supported. If the CLI owns an operation, do not reproduce it by hand with raw provider APIs, custom Wrangler configuration, migrations, auth configuration, or generated structure.

If required CLI support is missing, stop at the gap unless the user explicitly approves a described deviation and its maintenance consequences. Keep the approved plan as the source of intent. Re-running an operation should converge on existing state and resume completed work rather than duplicate or restart destructively.

The SetupPlan stores secret names and requirements only. Use Trestle encrypted-credential commands for approved secret setup. Never repeat decrypted values into conversation, files outside the credential system, command output, or logs. Invoke `secrets get`, `show`, or `export` only when the user explicitly asks to disclose values.

## Verify the outcome

Derive verification from the approved plan. As applicable, run:

- clean generation/regeneration and dependency checks;
- lint, typecheck, unit, integration, system, RLS, idempotency, and build checks;
- `trestle doctor` and plan convergence checks;
- migration status plus forced-RLS tests using the real application role;
- local boot and smoke tests for Astro, Better Auth, TanStack, Tailwind, email, and billing flows;
- remote resource, binding, GitHub Actions, and environment checks without exposing secrets;
- staging deployment and post-deploy smoke tests only when staging was approved;
- checks confirming no unapproved production, DNS, paid, or destructive mutation occurred.

Apply success is not completion. A failed verification leaves the plan resumable. Report the failing command, safe evidence, completed operations, recovery options, and the smallest next action.

## Report

State what was discovered, designed, created, reused, changed, verified, skipped, blocked, and deferred. Include cost assumptions, environment and deployment status, secret names and key locations without values, deviations from the plan, and exact next steps.
