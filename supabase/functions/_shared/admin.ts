// Admin account actions that need the service role (Supabase Auth admin API).
// The caller's role is read from the database (admin_roles) — never from the request body.

// deno-lint-ignore no-explicit-any
type Any = any;
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<Any>;
export interface AdminDeps {
  rpc: Rpc;
  /** auth.admin.updateUserById(userId, { password }) */
  setPassword: (userId: string, password: string) => Promise<{ error?: { message?: string; code?: string; status?: number } | null }>;
  log?: (...a: unknown[]) => void;
}
interface Result { status: number; body: Record<string, unknown> }

/** The password a reset sets. The member should change it after signing in. */
export const DEFAULT_RESET_PASSWORD = "Aa123456";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reset a member's password to DEFAULT_RESET_PASSWORD.
 * admin / owner only (viewer = read-only) · never on yourself · resetting another staff
 * account needs the owner, and the owner account can never be reset from here.
 * Rate limited with the other admin actions. Audited as "user.password_reset" (the password is never logged).
 */
export async function adminResetPassword(input: { adminId: string; userId: string; reason: string }, deps: AdminDeps): Promise<Result> {
  const reason = String(input.reason || "").trim();
  if (!UUID_RE.test(String(input.userId || ""))) return { status: 400, body: { error: "invalid_request" } };
  if (reason.length < 3 || reason.length > 500) return { status: 400, body: { error: "reason_required" } };
  const role = await deps.rpc("kfp_admin_role", { p_uid: input.adminId });
  if (role !== "admin" && role !== "owner") return { status: 403, body: { error: "forbidden" } };
  if (input.userId === input.adminId) return { status: 403, body: { error: "cannot_act_on_self" } };
  const targetRole = await deps.rpc("kfp_admin_role", { p_uid: input.userId });
  if (targetRole === "owner") return { status: 403, body: { error: "cannot_change_owner" } };
  if (targetRole && role !== "owner") return { status: 403, body: { error: "only_owner_can_change_admins" } };
  const allowed = await deps.rpc("kfp_rate_hit", { p_key: `admin:${input.adminId}`, p_max: 60, p_window_seconds: 3600 });
  if (allowed === false) return { status: 429, body: { error: "rate_limited" } };

  const { error } = await deps.setPassword(input.userId, DEFAULT_RESET_PASSWORD);
  if (error) {
    const msg = String(error.message || ""), code = String(error.code || "");
    deps.log?.("reset_password failed", code, msg);
    if (error.status === 404 || /not.?found/i.test(msg + code)) return { status: 404, body: { error: "user_not_found" } };
    if (/weak|pwned|leaked|password/i.test(code + " " + msg)) return { status: 422, body: { error: "weak_password", detail: msg.slice(0, 200) } };
    return { status: 502, body: { error: "auth_error" } };
  }
  await deps.rpc("kfp_admin_audit", { p: {
    action: "user.password_reset", admin_id: input.adminId, target_user_id: input.userId,
    target_table: "auth.users", target_id: input.userId, before: {}, after: { password: "default" }, reason } });
  return { status: 200, body: { reset: true, password: DEFAULT_RESET_PASSWORD } };
}
