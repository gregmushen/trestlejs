import type { CredentialStatus } from "./access.js";
import { apiKeyStatus, type ApplicationEnvironment } from "./api-keys.js";

/**
 * The credential-provider boundary. A verifier proves that a presented secret
 * is a live credential and names the Trestle service account behind it; it
 * never decides what that service account may do.
 */
export type IssueCredential = Readonly<{
  organizationId: string;
  serviceAccountId: string;
  environment: ApplicationEnvironment;
  scopes: readonly string[];
  expiresAt: Date | null;
  allowedCidrs: readonly string[] | null;
  /** The human who issues the key; providers that require an owning user record it. */
  issuedBy: string;
}>;

export type IssuedSecret = Readonly<{
  credentialId: string;
  /** Shown exactly once, never persisted or returned again. */
  token: string;
  displayPrefix: string;
}>;

export type VerifiedCredential = Readonly<{
  credentialId: string;
  organizationId: string;
  serviceAccountId: string;
  /** Null when the provider did not carry it; Trestle then fails closed. */
  environment: ApplicationEnvironment | null;
  scopes: readonly string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  allowedCidrs: readonly string[] | null;
}>;

export interface CredentialVerifier {
  readonly kind: "trestle" | "better_auth";
  issue(input: IssueCredential): Promise<IssuedSecret>;
  verify(presented: string): Promise<VerifiedCredential | null>;
  revoke(credentialId: string): Promise<void>;
}

export type CredentialAccessContext = Readonly<{
  now: Date;
  environment: ApplicationEnvironment;
  clientIp: string | null;
  /** The service account's own state and application-plane authority, from Trestle. */
  serviceAccount: Readonly<{ id: string; organizationId: string; status: "active" | "suspended"; authority: ReadonlySet<string> }>;
  /** Permissions the tenant's entitlements allow; omit when no permission is entitlement-gated. */
  entitled?: ReadonlySet<string>;
  /** The endpoint's required permission. */
  required: string;
}>;

export type CredentialAccess = Readonly<{ allowed: boolean; status: CredentialStatus | "wrong_principal" | "missing_constraints"; effective: readonly string[] }>;

/**
 * service-account authority ∩ key scopes ∩ tenant entitlements ∩ endpoint
 * policy ∩ environment and request constraints. Whatever the verifier
 * returns, a key can never exceed its service account.
 */
export function credentialAccess(credential: VerifiedCredential, context: CredentialAccessContext): CredentialAccess {
  if (credential.serviceAccountId !== context.serviceAccount.id || credential.organizationId !== context.serviceAccount.organizationId) {
    return { allowed: false, status: "wrong_principal", effective: [] };
  }
  // A provider that lost or never stored the environment is refused, not defaulted.
  if (credential.environment === null) return { allowed: false, status: "missing_constraints", effective: [] };
  const status = apiKeyStatus({ id: credential.credentialId, organizationId: credential.organizationId, serviceAccountId: credential.serviceAccountId, environment: credential.environment, scopes: credential.scopes, expiresAt: credential.expiresAt, revokedAt: credential.revokedAt, allowedCidrs: credential.allowedCidrs }, {
    now: context.now, environment: context.environment, clientIp: context.clientIp, serviceAccountStatus: context.serviceAccount.status,
  });
  const effective = credential.scopes.filter((scope) => context.serviceAccount.authority.has(scope) && (!context.entitled || context.entitled.has(scope))).sort();
  return { allowed: status === "active" && effective.includes(context.required), status, effective };
}
