export const runtime = 'nodejs';

export function GET(): Response {
  return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
}
