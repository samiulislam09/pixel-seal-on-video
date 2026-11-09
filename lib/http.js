// Small pure helpers for the Express routes in server.js.

/** Express 4 does not catch a rejected async handler: pass any error to next() (-> 500). */
export const asyncRoute = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (e) {
    next(e);
  }
};

// Routes a browser may call with a signed pass instead of the API key, and the methods each allows.
const PASS_ROUTES = [
  [/^\/uploads\/[^/]+$/, ["GET", "OPTIONS"]],
  [/^\/uploads\/[^/]+\/chunks\/\d+$/, ["PUT", "OPTIONS"]],
  [/^\/uploads\/[^/]+\/complete$/, ["POST", "OPTIONS"]],
  [/^\/videos\/[^/]+\/file$/, ["GET", "OPTIONS"]],
];

/** True when `method` + `path` (relative to /api) is a pass-authorised route. */
export const isPassRoute = (method, path) =>
  PASS_ROUTES.some(([re, methods]) => re.test(path) && methods.includes(String(method).toUpperCase()));

/** What POST /api/videos/:id/retry should do for record `v`. */
export function retryDecision(v, originalExists) {
  if (v.status !== "failed") return { kind: "not_failed" };
  if (!v.input || !originalExists) return { kind: "original_gone" };
  return { kind: "run" };
}
