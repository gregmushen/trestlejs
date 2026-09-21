import type { EmailAddress } from "./types.js";

export function formatAddress(address: EmailAddress): string {
  return typeof address === "string" ? address : address.name ? `${address.name} <${address.email}>` : address.email;
}

export function formatAddresses(addresses: EmailAddress | EmailAddress[]): string[] {
  return (Array.isArray(addresses) ? addresses : [addresses]).map(formatAddress);
}
