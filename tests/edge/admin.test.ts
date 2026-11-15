/* Phase 14: admin-actions reset_password (supabase/functions/_shared/admin.ts)
 * against the REAL Postgres test database (phase10 users) and a fake Auth admin API.
 * Run: PGHOST=… PGPORT=… PGUSER=postgres npx tsx tests/edge/admin.test.ts
 */
import { execFileSync } from "node:child_process";
import { adminResetPassword, DEFAULT_RESET_PASSWORD } from "../../supabase/functions/_shared/admin.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const DB = process.env.KFP_TEST_DB || "kfp_test";
let pass = 0, fail = 0;
function ok(c: unknown, n: string) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }
function sql(q: string, asService = false): string {
  return execFileSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", DB, "-c",
    (asService ? "select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false); set role service_role; " : "") + q],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim().split("\n").pop() || "";
}
const lit = (s: unknown) => s === null || s === undefined ? "null" : "'" + String(s).replace(/'/g, "''") + "'";
const rpc = async (fn: string, a: Record<string, unknown>) => {
  let call: string;
  if (fn === "kfp_rate_hit") call = `public.kfp_rate_hit(${lit(a.p_key)}, ${Number(a.p_max)}, ${Number(a.p_window_seconds)})`;
  else if (fn === "kfp_admin_role") call = `public.kfp_admin_role(${lit(a.p_uid)}::uuid)`;
  else call = `public.${fn}($kfp$${JSON.stringify(a.p)}$kfp$::jsonb)`;
  const out = sql(`select coalesce(to_json(${call})::text, 'null')`, true);
  return out ? JSON.parse(out) : null;
};

const U = { owner: "b1000000-0000-0000-0000-000000000001", admin: "b1000000-0000-0000-0000-000000000002",
            viewer: "b1000000-0000-0000-0000-000000000003", free: "b1000000-0000-0000-0000-000000000005",
            plus: "b1000000-0000-0000-0000-000000000006" };
const calls: Array<[string, string]> = [];
let authError: Any = null;
const deps = { rpc, setPassword: async (id: string, pw: string) => { calls.push([id, pw]); return { error: authError }; } };
const reset = (adminId: string, userId: string, reason = "ลืมรหัสผ่าน") => adminResetPassword({ adminId, userId, reason }, deps);

(async () => {
  console.log("A1 who may reset");
  let r = await reset(U.viewer, U.free);
  ok(r.status === 403 && r.body.error === "forbidden" && calls.length === 0, "viewer → 403, Auth not called");
  r = await reset(U.free, U.plus);
  ok(r.status === 403, "member → 403");
  r = await reset(U.admin, U.admin);
  ok(r.status === 403 && r.body.error === "cannot_act_on_self", "not on self");
  r = await reset(U.admin, U.viewer);
  ok(r.status === 403 && r.body.error === "only_owner_can_change_admins", "admin cannot reset another staff account");
  r = await reset(U.admin, U.owner);
  ok(r.status === 403 && r.body.error === "cannot_change_owner", "nobody resets the owner");
  r = await reset(U.admin, U.free, "x");
  ok(r.status === 400 && r.body.error === "reason_required", "reason required");
  r = await reset(U.admin, "not-a-uuid");
  ok(r.status === 400, "bad user id → 400");
  ok(calls.length === 0, "no Auth call for refused requests");

  console.log("A2 admin resets a member");
  const before = Number(sql(`select count(*) from public.admin_audit_logs where action='user.password_reset'`));
  r = await reset(U.admin, U.free);
  ok(r.status === 200 && r.body.password === DEFAULT_RESET_PASSWORD && DEFAULT_RESET_PASSWORD === "Aa123456", "200 + default password");
  ok(calls.length === 1 && calls[0][0] === U.free && calls[0][1] === "Aa123456", "Auth admin API called once for the member");
  const log = sql(`select action || '|' || admin_id || '|' || after::text from public.admin_audit_logs where action='user.password_reset' order by id desc limit 1`);
  ok(Number(sql(`select count(*) from public.admin_audit_logs where action='user.password_reset'`)) === before + 1 && log.startsWith("user.password_reset|" + U.admin), "audited");
  ok(!log.includes("Aa123456"), "password not written to the audit log");

  console.log("A3 owner may reset staff; Auth errors are reported");
  r = await reset(U.owner, U.viewer);
  ok(r.status === 200, "owner resets a viewer");
  authError = { message: "Password is known to be weak and easy to guess", code: "weak_password", status: 422 };
  r = await reset(U.owner, U.plus);
  ok(r.status === 422 && r.body.error === "weak_password", "weak_password → 422");
  authError = { message: "User not found", status: 404 };
  r = await reset(U.owner, "b1000000-0000-0000-0000-0000000000ff");
  ok(r.status === 404 && r.body.error === "user_not_found", "unknown user → 404");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
