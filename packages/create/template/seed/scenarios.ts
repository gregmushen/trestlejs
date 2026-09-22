export type SeedUser = Readonly<{ id: string; name: string; email: string }>;
export type SeedOrganization = Readonly<{ id: string; name: string; slug: string; ownerId: string }>;
export type SeedRecord = Readonly<{ id: string; organizationId: string; name: string }>;
export type SeedScenario = Readonly<{ name: string; users: readonly SeedUser[]; organizations: readonly SeedOrganization[]; records: readonly SeedRecord[] }>;

const greg = { id: "seed-user-greg", name: "Greg Example", email: "greg@example.test" } as const;
const alice = { id: "seed-user-alice", name: "Alice Example", email: "alice@example.test" } as const;
const acme = { id: "seed-org-acme", name: "Acme", slug: "acme", ownerId: greg.id } as const;
const beacon = { id: "seed-org-beacon", name: "Beacon", slug: "beacon", ownerId: alice.id } as const;

export const seedScenarios = {
  default: { name: "default", users: [greg], organizations: [acme], records: [{ id: "00000000-0000-4000-8000-000000000001", organizationId: acme.id, name: "Welcome" }] },
  demo: { name: "demo", users: [greg, alice], organizations: [acme, beacon], records: [{ id: "00000000-0000-4000-8000-000000000001", organizationId: acme.id, name: "Acme example" }, { id: "00000000-0000-4000-8000-000000000002", organizationId: beacon.id, name: "Beacon example" }] },
  "tenant-isolation": { name: "tenant-isolation", users: [greg, alice], organizations: [acme, beacon], records: [{ id: "00000000-0000-4000-8000-000000000011", organizationId: acme.id, name: "Acme private record" }, { id: "00000000-0000-4000-8000-000000000012", organizationId: beacon.id, name: "Beacon private record" }] },
} as const satisfies Record<string, SeedScenario>;

export type SeedScenarioName = keyof typeof seedScenarios;
