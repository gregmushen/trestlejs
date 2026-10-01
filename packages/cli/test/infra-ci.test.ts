import { describe, expect, it } from "vitest";

import { infraWorkflowIssues } from "../src/infra/ci-trust.js";

const trusted = `name: Infrastructure
on:
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
  apply:
    needs: build
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v6
      - run: npm install --global trestlejs@0.1.0 --ignore-scripts
      - run: trestle --experimental infra apply .trestle/infrastructure.local/plans/plan.json --env staging --approval approval.json
        env:
          TRESTLE_INFRA_CONTROL_DATABASE_URL: \${{ secrets.TRESTLE_INFRA_CONTROL_DATABASE_URL }}
`;

describe("infrastructure CI trust boundary (AR-06)", () => {
  it("accepts a protected, manually triggered mutation job separated from the build", () => {
    expect(infraWorkflowIssues("infra.yml", trusted)).toEqual([]);
  });

  it("flags mutation reachable from fork or same-repository pull requests and pull_request_target", () => {
    for (const trigger of ["pull_request", "pull_request_target", "workflow_run", "issue_comment"]) {
      const issues = infraWorkflowIssues("infra.yml", trusted.replace("  workflow_dispatch:", `  ${trigger}:`));
      expect(issues.join(" "), trigger).toMatch(new RegExp(`untrusted trigger ${trigger}`, "u"));
      expect(issues.join(" ")).toMatch(/control-store secret/u);
    }
  });

  it("flags a privileged job without a protected environment", () => {
    expect(infraWorkflowIssues("infra.yml", trusted.replace("    environment: staging\n", "")).join(" ")).toMatch(/protected GitHub environment/u);
  });

  it("flags lifecycle scripts, application code and untrusted checkouts in the privileged job", () => {
    const install = trusted.replace("npm install --global trestlejs@0.1.0 --ignore-scripts", "pnpm install --frozen-lockfile");
    expect(infraWorkflowIssues("infra.yml", install).join(" ")).toMatch(/lifecycle scripts/u);
    const build = trusted.replace("npm install --global trestlejs@0.1.0 --ignore-scripts", "pnpm build");
    expect(infraWorkflowIssues("infra.yml", build).join(" ")).toMatch(/runs application code/u);
    const head = trusted.replace("      - uses: actions/checkout@v6\n      - run: npm install", "      - uses: actions/checkout@v6\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: npm install");
    expect(infraWorkflowIssues("infra.yml", head).join(" ")).toMatch(/pull-request head code/u);
    const interpolation = trusted.replace("--approval approval.json", "--approval \${{ github.event.pull_request.title }}");
    expect(infraWorkflowIssues("infra.yml", interpolation).join(" ")).toMatch(/untrusted event data/u);
  });

  it("covers approve, resume and approver registration as privileged", () => {
    for (const command of ["infra approve plan.json --env staging", "infra operation resume op-1 --env staging", "infra approver register alice"]) {
      const workflow = trusted.replace(/infra apply [^\n]+/u, command).replace("  workflow_dispatch:", "  pull_request:");
      expect(infraWorkflowIssues("infra.yml", workflow).join(" "), command).toMatch(/untrusted trigger/u);
    }
  });

  it("ignores workflows without privileged infrastructure commands", () => {
    expect(infraWorkflowIssues("ci.yml", "on: pull_request\njobs:\n  check:\n    steps:\n      - run: trestle --experimental infra plan --env staging\n")).toEqual([]);
  });
});
