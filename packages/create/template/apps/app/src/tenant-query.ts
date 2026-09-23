/** Tenant-scoped cache identity includes the signed-in user as well as the
 * active organization. Neither a tenant switch nor a new session can reuse
 * another principal's billing projection. */
export function billingSubscriptionQueryKey(userId: string | undefined, organizationId: string | undefined) {
  return ["billing-subscription", userId, organizationId] as const;
}
