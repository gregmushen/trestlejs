export type Permission = string & { readonly __permission: unique symbol };

export function permission(value: string): Permission {
  return value as Permission;
}
