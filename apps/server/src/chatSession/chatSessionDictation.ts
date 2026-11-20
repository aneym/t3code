const DICTATION_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/api\/voice\/status$/],
  ["GET", /^\/api\/voice\/models$/],
  ["GET", /^\/api\/voice\/cloud\/keys$/],
  ["GET", /^\/api\/voice\/cloud\/openrouter\/models$/],
  ["POST", /^\/api\/voice\/transcribe$/],
  ["POST", /^\/api\/voice\/cloud\/[^/]+\/transcribe$/],
  ["POST", /^\/api\/auth\/websocket-ticket\/media$/],
  ["GET", /^\/ws\/voice$/],
];

export const isDictationRoute = (method: string, path: string) =>
  DICTATION_ROUTES.some(([routeMethod, pattern]) => routeMethod === method && pattern.test(path));
