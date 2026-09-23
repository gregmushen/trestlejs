import { describe, expect, it } from "vitest";

import { ManifestError, parseProjectManifest } from "../src/index.js";

const validManifest = `
schemaVersion: 1
project:
  name: hello
apps:
  site: apps/site
  app: apps/app
  worker: apps/worker
packages:
  contracts: packages/contracts
tenancy:
  model: organization
  enforcement: postgres-rls
database:
  engine: postgresql
  defaultProvider: neon
site:
  framework: astro
  rendering: static
  starter: southwind
capabilities:
  r2: true
  queues: true
  workflows: true
  durableObjects: true
  admin: false
environments:
  - local
  - staging
  - production
`;

describe("project manifest", () => {
  it("parses a valid version-one manifest", () => {
    const manifest = parseProjectManifest(validManifest);
    expect(manifest.project.name).toBe("hello");
    expect(manifest.tenancy.enforcement).toBe("postgres-rls");
  });

  it("rejects unknown schema versions", () => {
    expect(() => parseProjectManifest(validManifest.replace("schemaVersion: 1", "schemaVersion: 2"))).toThrow(
      ManifestError,
    );
  });

  it("rejects paths that escape the project", () => {
    expect(() => parseProjectManifest(validManifest.replace("apps/app", "../app"))).toThrow(
      ManifestError,
    );
  });

  it("requires the local environment", () => {
    expect(() => parseProjectManifest(validManifest.replace("  - local\n", ""))).toThrow(
      ManifestError,
    );
  });

  it("permits a declared secret that is optional until a capability is enabled", () => {
    const manifest = parseProjectManifest(`${validManifest}\nsecrets:\n  ARTIFACT_SIGNING_SECRET:\n    target: worker\n    required: []\n`);
    expect(manifest.secrets?.ARTIFACT_SIGNING_SECRET.required).toEqual([]);
  });

  it("parses optional integration, access, commercial, and artifact declarations", () => {
    const manifest = parseProjectManifest(`${validManifest}integrations:
  email: resend
  payments: lago
access:
  customRoles: true
  serviceAccounts: true
  apiKeys: true
commercial:
  plans: true
  usage: false
artifacts:
  storage: r2
  retentionDays: 30
`);
    expect(manifest.integrations).toEqual({ email: "resend", payments: "lago" });
    expect(manifest.artifacts?.retentionDays).toBe(30);
    expect(parseProjectManifest(validManifest).access).toBeUndefined();
  });

  it("parses communications and support-session declarations", () => {
    const manifest = parseProjectManifest(validManifest.replace("admin: false", "admin: true") + "access:\n  customRoles: true\n  serviceAccounts: true\n  apiKeys: true\n  supportSessions: true\n  impersonation: false\ncommunications:\n  webhooks: true\n  notifications: false\n");
    expect(manifest.access).toMatchObject({ supportSessions: true, impersonation: false });
    expect(manifest.communications).toEqual({ webhooks: true, notifications: false });
  });

  it("keeps impersonation off and support sessions inside the admin capability", () => {
    const issues = (text: string) => { try { parseProjectManifest(text); return []; } catch (error) { return (error as ManifestError).issues.map((issue) => issue.message); } };
    expect(issues(`${validManifest}access:\n  customRoles: false\n  serviceAccounts: false\n  apiKeys: false\n  impersonation: true\n`)).toEqual([expect.stringMatching(/impersonation/u)]);
    expect(issues(`${validManifest}access:\n  customRoles: false\n  serviceAccounts: false\n  apiKeys: false\n  supportSessions: true\n`)).toEqual([expect.stringMatching(/capabilities.admin/u)]);
  });

  it("rejects inconsistent optional declarations", () => {
    expect(() => parseProjectManifest(`${validManifest}access:\n  customRoles: false\n  serviceAccounts: false\n  apiKeys: true\n`)).toThrow(ManifestError);
    expect(() => parseProjectManifest(`${validManifest}integrations:\n  email: local\n  payments: lago\n`)).toThrow(ManifestError);
    expect(() => parseProjectManifest(`${validManifest}artifacts:\n  storage: r2\n  retentionDays: 0\n`)).toThrow(ManifestError);
    expect(() => parseProjectManifest(`${validManifest}integrations:\n  email: sendgrid\n  payments: local\n`)).toThrow(ManifestError);
  });

  it("accepts capability choices and rejects incompatible provider combinations", () => {
    const issues = (text: string) => { try { parseProjectManifest(text); return []; } catch (error) { return (error as ManifestError).issues.map((issue) => issue.message); } };
    const admin = validManifest.replace("admin: false", "admin: true");
    const commercial = "commercial:\n  plans: true\n  usage: true\n";
    const manifest = parseProjectManifest(`${admin}integrations:\n  email: resend\n  payments: stripe\n  metering: openmeter\n  webhooks: svix\nauthentication:\n  passkeys: better-auth\n  twoFactor: disabled\nidentity:\n  sso: better-auth\n  directory: better-auth-scim\ncommunications:\n  webhooks: true\n  notifications: true\n${commercial}`);
    expect(manifest.identity).toEqual({ sso: "better-auth", directory: "better-auth-scim" });
    expect(manifest.integrations?.metering).toBe("openmeter");
    expect(issues(`${validManifest}integrations:\n  email: local\n  payments: stripe\n  metering: openmeter\n`)).toEqual([expect.stringMatching(/commercial.usage/u)]);
    expect(issues(`${validManifest}integrations:\n  email: local\n  payments: stripe\n  metering: lago\n${commercial}`)).toEqual([expect.stringMatching(/requires payments: lago/u)]);
    expect(issues(`${validManifest}integrations:\n  email: local\n  payments: local\n  webhooks: svix\n`)).toEqual([expect.stringMatching(/communications.webhooks/u)]);
    expect(issues(`${admin}authentication:\n  passkeys: disabled\n  twoFactor: disabled\n`)).toEqual([expect.stringMatching(/step-up/u)]);
    expect(issues(`${validManifest}authentication:\n  passkeys: disabled\n  twoFactor: disabled\n`)).toEqual([]);
    expect(issues(`${validManifest}identity:\n  sso: disabled\n  directory: workos\n`)).toEqual(expect.arrayContaining([expect.stringMatching(/requires SSO/u)]));
    expect(issues(`${validManifest}identity:\n  sso: better-auth\n  directory: workos\n`)).toEqual([expect.stringMatching(/WorkOS SSO/u)]);
    expect(issues(`${validManifest}identity:\n  sso: workos\n  directory: better-auth-scim\n`)).toEqual([expect.stringMatching(/Better Auth SSO/u)]);
    expect(issues(`${validManifest}identity:\n  sso: stytch\n  directory: disabled\n`)).toEqual([expect.stringMatching(/Stytch adapter is not available/u)]);
  });

  it("parses regional defaults and rejects non-canonical identifiers", () => {
    const issues = (text: string) => { try { parseProjectManifest(text); return []; } catch (error) { return (error as ManifestError).issues.map((issue) => issue.message); } };
    const regional = (fields: string) => `${validManifest}regional:\n${fields}`;
    const manifest = parseProjectManifest(regional("  language: en\n  locale: en-US\n  timeZone: America/Los_Angeles\n  currency: USD\n"));
    expect(manifest.regional).toEqual({ language: "en", locale: "en-US", timeZone: "America/Los_Angeles", currency: "USD", organizationSettings: true, i18n: { enabled: false, languages: ["en"] } });
    expect(issues(regional("  language: en\n  locale: en-US\n  timeZone: +07:00\n  currency: USD\n"))).toEqual([expect.stringMatching(/IANA/u)]);
    expect(issues(regional("  language: en\n  locale: en_us\n  timeZone: UTC\n  currency: USD\n"))).toEqual([expect.stringMatching(/BCP 47/u)]);
    expect(issues(regional("  language: en\n  locale: en-US\n  timeZone: UTC\n  currency: usd\n"))).toEqual([expect.stringMatching(/ISO 4217/u)]);
    expect(issues(regional("  language: en\n  locale: en-US\n  timeZone: UTC\n  currency: USD\n  i18n:\n    enabled: true\n    languages: [es]\n"))).toEqual([expect.stringMatching(/include the application language/u)]);
  });
});
