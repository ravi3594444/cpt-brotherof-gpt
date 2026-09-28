// The local world (next dev and next start, and the browser checks) picks up Research jobs that were
// running when the server stopped. Vercel's world needs nothing here.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.WORKFLOW_TARGET_WORLD === "local") {
    const { getWorld } = await import("workflow/runtime");
    await getWorld().start?.();
  }
}
