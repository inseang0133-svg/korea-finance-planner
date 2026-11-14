-- replica of production schema as of 2026-11-14 (no functions, no triggers)
create table public.profiles (user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique, nickname text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.user_data (user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
alter table public.profiles enable row level security; alter table public.user_data enable row level security;
create policy profiles_delete_own on public.profiles for delete to authenticated using (auth.uid() = user_id);
create policy profiles_insert_own on public.profiles for insert to authenticated with check (auth.uid() = user_id);
create policy profiles_select_own on public.profiles for select to authenticated using (auth.uid() = user_id);
create policy profiles_update_own on public.profiles for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy user_data_delete_own on public.user_data for delete to authenticated using (auth.uid() = user_id);
create policy user_data_insert_own on public.user_data for insert to authenticated with check (auth.uid() = user_id);
create policy user_data_select_own on public.user_data for select to authenticated using (auth.uid() = user_id);
create policy user_data_update_own on public.user_data for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant all on public.profiles, public.user_data to anon, authenticated, service_role;
alter publication supabase_realtime add table public.user_data;
-- accounts: some with a profile, one legacy + one real e-mail WITHOUT a profile (as in production)
insert into auth.users (id, email, email_confirmed_at) values
 ('e2000000-0000-0000-0000-000000000001','withprofile@kfp.example.com',now()),
 ('e2000000-0000-0000-0000-000000000002','noprofile@kfp.example.com',now()),
 ('e2000000-0000-0000-0000-000000000003','someone@gmail.com',now());
insert into public.profiles (user_id, username, nickname) values ('e2000000-0000-0000-0000-000000000001','withprofile',null);
insert into public.user_data (user_id, data) values
 ('e2000000-0000-0000-0000-000000000001', jsonb_build_object('salary','1000','kfp_gold_lots_v1','[{"id":"g1","grams":1,"costThb":3000}]'));
