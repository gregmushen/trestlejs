/**
 * Enterprise identity ports. Providers supply identities, connection bindings,
 * and provisioning facts; Trestle alone decides what authority those facts
 * grant. Nothing here carries a provider's own RBAC.
 */

export type SsoProviderKind = "better_auth" | "workos";
export type DirectoryProviderKind = "better_auth_scim" | "workos";

/** A person verified by an enterprise connection, normalized across providers. */
export type ExternalIdentity = Readonly<{
  provider: SsoProviderKind;
  /** The provider's connection (IdP configuration) that authenticated the person. */
  connectionId: string;
  /** Stable subject at the provider; never an email address. */
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  /** The Trestle organization bound to the connection, when the binding is known. */
  organizationId: string | null;
}>;

export type SignInRequest = Readonly<{
  /** Route by the Trestle organization's bound connection, or by the person's email domain. */
  organizationId?: string;
  domain?: string;
  redirectUri: string;
  /** Opaque CSRF state; the caller stores it and checks it on return. */
  state: string;
}>;

export interface SsoProvider {
  readonly kind: SsoProviderKind;
  /** Where to send the browser to start sign-in. */
  authorizationUrl(request: SignInRequest): Promise<string>;
  /** Exchanges the returned code for a verified identity. */
  completeSignIn(code: string): Promise<ExternalIdentity>;
}

export type DirectoryGroupRef = Readonly<{ externalGroupId: string; name: string }>;

/** A provisioned user's current state as the directory reports it. */
export type DirectoryUser = Readonly<{
  provider: DirectoryProviderKind;
  directoryId: string;
  externalId: string;
  email: string;
  name: string | null;
  active: boolean;
  groups: readonly DirectoryGroupRef[];
}>;

export type DirectoryEvent = Readonly<{
  /** Provider event ID; processing is idempotent per ID. */
  id: string;
  type: "user.upserted" | "user.deactivated" | "user.deleted" | "group.membership_changed";
  directoryId: string;
  organizationId: string | null;
  occurredAt: Date;
  user: DirectoryUser;
}>;

/** Verifies and normalizes an inbound directory webhook. Unverifiable input throws. */
export interface DirectoryEventSource {
  readonly kind: DirectoryProviderKind;
  verify(request: Readonly<{ body: string; headers: Readonly<Record<string, string | undefined>> }>, now: Date): Promise<DirectoryEvent[]>;
}

export class IdentityVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityVerificationError";
  }
}
