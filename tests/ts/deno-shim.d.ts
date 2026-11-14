// Type-check shim so plain `tsc` can check Edge Functions without Deno.
// Real types come from Deno + npm:@supabase/supabase-js at deploy time.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};
declare module "npm:@supabase/supabase-js@2.97.0" {
  type Res<T = any> = Promise<{ data: T; error: { message: string; code?: string } | null }>;
  interface Session { access_token: string; refresh_token: string; user: { id: string; email?: string } }
  interface Query { select(c?: string): Query; eq(c: string, v: unknown): Query; maybeSingle(): Res; single(): Res;
    insert(v: unknown): Query; update(v: unknown): Query; upsert(v: unknown, o?: unknown): Query; then: Res["then"] }
  export interface SupabaseClient {
    rpc(fn: string, args?: Record<string, unknown>): Res;
    from(t: string): Query;
    auth: {
      signInWithPassword(c: { email: string; password: string }): Promise<{ data: { session: Session | null; user: unknown }; error: { message: string; code?: string } | null }>;
      getUser(jwt?: string): Promise<{ data: { user: { id: string; email?: string; email_confirmed_at?: string | null } | null }; error: unknown }>;
      admin: { getUserById(id: string): Res; updateUserById(id: string, a: Record<string, unknown>): Res };
    };
  }
  export function createClient(url: string, key: string, opts?: unknown): SupabaseClient;
}
declare module "npm:stripe@^16" {
  // Minimal surface used by _shared/stripe.ts (real types ship with the SDK at deploy time).
  // deno-lint-ignore no-explicit-any
  type Any = any;
  class Stripe {
    constructor(key: string, opts?: Any);
    static createFetchHttpClient(): Any;
    static createSubtleCryptoProvider(): Any;
    webhooks: { constructEventAsync(body: string, sig: string, secret: string, tolerance?: number, provider?: Any): Promise<Any> };
    subscriptions: { retrieve(id: string): Promise<Any>; update(id: string, params: Any, opts?: Any): Promise<Any>; cancel(id: string, params?: Any): Promise<Any> };
    invoices: { retrieve(id: string, params?: Any): Promise<Any> };
    charges: { retrieve(id: string): Promise<Any> };
    refunds: { list(params: Any): Promise<{ data: Any[] }> };
    customers: { create(params: Any, opts?: Any): Promise<Any> };
    products: { retrieve(id: string): Promise<Any>; create(params: Any, opts?: Any): Promise<Any> };
    prices: { create(params: Any, opts?: Any): Promise<Any> };
    checkout: { sessions: { create(params: Any, opts?: Any): Promise<Any> } };
    billingPortal: { sessions: { create(params: Any): Promise<Any> } };
  }
  export default Stripe;
}
