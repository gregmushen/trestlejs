export type StructuredOutput<T> = {
  schemaVersion: 1;
  data: T;
};

export function structuredOutput<T>(data: T): StructuredOutput<T> {
  return { schemaVersion: 1, data };
}
