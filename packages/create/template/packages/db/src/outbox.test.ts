import { describe, expect, it } from "vitest";
import { outboxApplicationConnectionString } from "./outbox.js";

describe("outbox runtime connection", () => {
  it("assumes the restricted application role without dropping existing startup options", () => {
    const connection = outboxApplicationConnectionString("postgres://runtime:secret@localhost/app?sslmode=require&options=-c%20statement_timeout%3D5s");
    const url = new URL(connection);
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("options")).toBe("-c statement_timeout=5s -c role=trestle_app");
  });
});
