import { expect, test } from "@playwright/test";

const apiOrigin = `http://localhost:${process.env.TRESTLE_BROWSER_WORKER_PORT ?? 8787}`;

type SchedulerState = { configured: boolean; alarmAt: string | null; work: Array<{ key: string; dueAt: string }> };

test("the due-time scheduler's Durable Object alarm fires under wrangler dev and returns to idle", async ({ request }) => {
  test.skip(process.env.TRESTLE_BROWSER_MODE === "deployed", "The scheduler state route is local only");
  const state = async () => await (await request.get(`${apiOrigin}/api/dev/scheduler`)).json() as SchedulerState;
  expect((await state()).configured).toBe(true);
  const probe = await request.post(`${apiOrigin}/api/dev/scheduler/probe?delayMs=1500`);
  expect(probe.status()).toBe(202);
  const { key, dueAt } = await probe.json() as { key: string; dueAt: string };
  // Until it is due, the object's own state holds the work and its alarm.
  const armed = await state();
  expect(armed.work).toContainEqual({ key, dueAt });
  expect(armed.alarmAt).not.toBeNull();
  await expect.poll(async () => (await state()).work.some((item) => item.key === key), { timeout: 15_000 }).toBe(false);
  expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(dueAt));
  // With nothing pending there is no alarm.
  await expect.poll(async () => (await state()).alarmAt, { timeout: 5_000 }).toBeNull();
});
