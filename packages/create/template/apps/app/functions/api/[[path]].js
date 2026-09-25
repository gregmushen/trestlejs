export async function onRequest(context) {
  if (!context.env.TRESTLE_API) return new Response("API binding unavailable", { status: 503 });
  return context.env.TRESTLE_API.fetch(context.request);
}
