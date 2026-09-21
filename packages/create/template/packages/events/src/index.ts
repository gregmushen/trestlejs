import { z } from "zod";

export const eventEnvelopeSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  resource: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
