// An optional access code keeps a public deployment from spending the owner's
// model and browser credit. Set SCOUT_ACCESS_CODE on the server to turn it on.

export const ACCESS_HEADER = "x-scout-access";

/** Whether a request may use Scout: always when no code is set, otherwise only with the exact code. */
export function accessAllowed(code: string, provided: string | null | undefined): boolean {
  if (!code) return true;
  const given = provided ?? "";
  // Compare every character so the response time does not reveal how much matched.
  let difference = code.length ^ given.length;
  for (let i = 0; i < code.length; i++)
    difference |= code.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  return difference === 0;
}

/** The refusal for a request from another site, or without the access code; undefined when it may go on. */
export function refuse(request: Request, code: string): Response | undefined {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return new Response("This request must come from your Scout workspace.", { status: 403 });
  if (!accessAllowed(code, request.headers.get(ACCESS_HEADER)))
    return new Response("Scout needs its access code. Reload Scout and enter it again.", { status: 401 });
}
