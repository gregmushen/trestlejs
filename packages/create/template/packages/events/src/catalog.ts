import { z } from "zod";

export type EventResource = Readonly<{ type: string; id: string }>;
export type EventSensitivity = "internal" | "confidential" | "restricted";
export type PublicSensitivity = Readonly<{
  classification: "public" | "customer" | "sensitive";
  retentionClass: "standard" | "short";
}>;

export type PublicEventMetadata = Readonly<{
  type: string;
  version: number;
  description: string;
  schema: unknown;
  examples: readonly unknown[];
  sensitivity: PublicSensitivity;
  entitlement?: string;
}>;

export type PublicProjection = Readonly<{ type: string; version: number; resource: EventResource; data: unknown }>;

export class EventCatalogError extends Error {
  constructor(message: string) { super(message); this.name = "EventCatalogError"; }
}

const dottedName = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const resourceType = /^[a-z][a-z0-9_]*$/u;
const reservedName = /^(?:trestle|webhook)\./u;

function assertName(value: string, kind: string): void {
  if (!dottedName.test(value) || reservedName.test(value)) throw new EventCatalogError(`${kind} must be a non-reserved lowercase dotted name`);
}

function assertDescription(value: string, kind: string): void {
  if (!value.trim() || value !== value.trim()) throw new EventCatalogError(`${kind} needs a trimmed description`);
}

function assertVersion(value: number, kind: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new EventCatalogError(`${kind} version must be a positive integer`);
}

export type ApplicationEventDefinition = Readonly<{
  name: string;
  schemaVersion: number;
  description: string;
  sensitivity: EventSensitivity;
  parseInternal(payload: unknown): unknown;
  resource(payload: unknown): EventResource;
  webhook?: Readonly<{
    metadata: PublicEventMetadata;
    project(payload: unknown, resource: EventResource): unknown;
  }>;
}>;

export function defineEvent<Payload>(definition: {
  name: string;
  schemaVersion: number;
  description: string;
  resource: { type: string; id: (payload: Payload) => string };
  payload: z.ZodType<Payload>;
  sensitivity: EventSensitivity;
  webhook?: {
    type: string;
    version: number;
    description: string;
    payload: z.ZodType;
    project: (payload: Payload, resource: EventResource) => unknown;
    sensitivity: PublicSensitivity;
    examples: readonly unknown[];
    fixtures: readonly { internal: Payload; public: unknown }[];
    entitlement?: string;
  };
}): ApplicationEventDefinition {
  assertName(definition.name, "Internal event name");
  assertVersion(definition.schemaVersion, "Internal event");
  assertDescription(definition.description, "Internal event");
  if (!resourceType.test(definition.resource.type)) throw new EventCatalogError("Event resource type must be a lowercase identifier");
  if (!["internal", "confidential", "restricted"].includes(definition.sensitivity)) throw new EventCatalogError("Internal event sensitivity is required");

  let webhook: ApplicationEventDefinition["webhook"];
  if (definition.webhook) {
    const publicDefinition = definition.webhook;
    assertName(publicDefinition.type, "Public event type");
    assertVersion(publicDefinition.version, "Public event");
    assertDescription(publicDefinition.description, "Public event");
    if (!["public", "customer", "sensitive"].includes(publicDefinition.sensitivity?.classification)
      || !["standard", "short"].includes(publicDefinition.sensitivity?.retentionClass)) {
      throw new EventCatalogError("Public sensitivity and retention classification are required");
    }
    if (publicDefinition.entitlement !== undefined && !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(publicDefinition.entitlement)) {
      throw new EventCatalogError("Public event entitlement must be a lowercase dotted identifier");
    }
    if (!publicDefinition.examples.length) throw new EventCatalogError("Public event needs at least one example");
    if (!publicDefinition.fixtures.length) throw new EventCatalogError("Public event needs a projection fixture");
    const examples = publicDefinition.examples.map((example) => {
      const parsed = publicDefinition.payload.safeParse(example);
      if (!parsed.success) throw new EventCatalogError("Public event example fails its schema");
      return parsed.data;
    });
    let schema: unknown;
    try { schema = z.toJSONSchema(publicDefinition.payload); }
    catch { throw new EventCatalogError("Public event schema cannot be represented as JSON Schema"); }
    for (const fixture of publicDefinition.fixtures) {
      const parsedInternal = definition.payload.safeParse(fixture.internal);
      if (!parsedInternal.success) throw new EventCatalogError("Projection fixture fails the internal schema");
      let projected: unknown;
      try {
        const id = definition.resource.id(parsedInternal.data);
        if (typeof id !== "string" || !id.trim()) throw new Error("Invalid resource");
        projected = publicDefinition.project(parsedInternal.data, { type: definition.resource.type, id });
      } catch { throw new EventCatalogError("Projection fixture could not be evaluated"); }
      const parsedPublic = publicDefinition.payload.safeParse(projected);
      const expectedPublic = publicDefinition.payload.safeParse(fixture.public);
      if (!parsedPublic.success || !expectedPublic.success || JSON.stringify(parsedPublic.data) !== JSON.stringify(expectedPublic.data)) {
        throw new EventCatalogError("Projection fixture does not match its public schema and expected output");
      }
    }
    const metadata: PublicEventMetadata = {
      type: publicDefinition.type,
      version: publicDefinition.version,
      description: publicDefinition.description,
      schema,
      examples,
      sensitivity: publicDefinition.sensitivity,
      ...(publicDefinition.entitlement ? { entitlement: publicDefinition.entitlement } : {}),
    };
    webhook = {
      metadata,
      project: (payload, resource) => {
        try {
          const projected = publicDefinition.project(payload as Payload, resource);
          const parsed = publicDefinition.payload.safeParse(projected);
          if (!parsed.success) throw new EventCatalogError("Public projection fails its schema");
          return parsed.data;
        } catch { throw new EventCatalogError("Public projection failed validation"); }
      },
    };
  }

  return {
    name: definition.name,
    schemaVersion: definition.schemaVersion,
    description: definition.description,
    sensitivity: definition.sensitivity,
    parseInternal: (payload) => {
      const parsed = definition.payload.safeParse(payload);
      if (!parsed.success) throw new EventCatalogError("Internal event payload fails its schema");
      return parsed.data;
    },
    resource: (payload) => {
      const parsed = definition.payload.safeParse(payload);
      if (!parsed.success) throw new EventCatalogError("Internal event payload fails its schema");
      let id: string;
      try { id = definition.resource.id(parsed.data); }
      catch { throw new EventCatalogError("Event resource identifier is invalid"); }
      if (typeof id !== "string" || !id.trim()) throw new EventCatalogError("Event resource identifier is invalid");
      return { type: definition.resource.type, id };
    },
    ...(webhook ? { webhook } : {}),
  };
}

export function defineEventCatalog(definitions: readonly ApplicationEventDefinition[]) {
  const internal = new Map<string, ApplicationEventDefinition>();
  const publicEvents = new Map<string, ApplicationEventDefinition>();
  for (const definition of definitions) {
    const internalKey = `${definition.name}@${definition.schemaVersion}`;
    if (internal.has(internalKey)) throw new EventCatalogError(`Duplicate internal event ${internalKey}`);
    internal.set(internalKey, definition);
    if (!definition.webhook) continue;
    const publicKey = `${definition.webhook.metadata.type}@${definition.webhook.metadata.version}`;
    const existing = publicEvents.get(publicKey);
    if (existing) {
      if (existing.name !== definition.name || JSON.stringify(existing.webhook!.metadata) !== JSON.stringify(definition.webhook.metadata)) {
        throw new EventCatalogError(`Duplicate public event ${publicKey}`);
      }
    } else publicEvents.set(publicKey, definition);
  }
  return {
    has(name: string, schemaVersion: number): boolean {
      return internal.has(`${name}@${schemaVersion}`);
    },
    parse(name: string, schemaVersion: number, payload: unknown): unknown {
      const definition = internal.get(`${name}@${schemaVersion}`);
      if (!definition) throw new EventCatalogError(`Internal event ${name}@${schemaVersion} is not registered`);
      return definition.parseInternal(payload);
    },
    resource(name: string, schemaVersion: number, payload: unknown): EventResource {
      const definition = internal.get(`${name}@${schemaVersion}`);
      if (!definition) throw new EventCatalogError(`Internal event ${name}@${schemaVersion} is not registered`);
      return definition.resource(payload);
    },
    project(name: string, schemaVersion: number, payload: unknown): PublicProjection | null {
      const definition = internal.get(`${name}@${schemaVersion}`);
      if (!definition) throw new EventCatalogError(`Internal event ${name}@${schemaVersion} is not registered`);
      const parsed = definition.parseInternal(payload);
      if (!definition.webhook) return null;
      const resource = definition.resource(parsed);
      return { type: definition.webhook.metadata.type, version: definition.webhook.metadata.version, resource, data: definition.webhook.project(parsed, resource) };
    },
    publicEvents(): PublicEventMetadata[] {
      return [...publicEvents.values()].map((definition) => structuredClone(definition.webhook!.metadata))
        .sort((left, right) => left.type.localeCompare(right.type) || left.version - right.version);
    },
  };
}
