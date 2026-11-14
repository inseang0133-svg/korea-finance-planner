// Service-role Supabase client + rpc helper for Edge Functions.
import { createClient } from "npm:@supabase/supabase-js@2.97.0";

export function adminClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function rpcVia(client: ReturnType<typeof adminClient>) {
  return async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
}

// The caller's user (verified e-mail required by the billing functions themselves).
export async function userFromRequest(req: Request, client: ReturnType<typeof adminClient>) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export function siteUrl(): string {
  const s = Deno.env.get("SITE_URL");
  if (!s) throw new Error("SITE_URL is not set");
  return s;
}
