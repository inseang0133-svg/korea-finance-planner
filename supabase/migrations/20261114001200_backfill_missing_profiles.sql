-- =====================================================================
-- Korea Finance Planner · Backfill profiles for auth users that have none
--
-- Before the SaaS upgrade, production had NO trigger on auth.users: the old
-- web app inserted the profile row from the browser. A few accounts ended up
-- without a profile (sign-up interrupted, or created outside the app). After
-- 0100 revokes INSERT on profiles from `authenticated`, those accounts could
-- never get one, so they would be invisible to admin, the launch grant,
-- username login and plan checks.
--
-- Same naming rule as handle_new_kfp_user(). Additive, re-runnable.
-- Run after 0100 (needs kfp_normalize_username + the new profile columns).
-- =====================================================================
do $$
declare
  u     record;
  base  text;
  uname text;
  nick  text;
  n     int;
begin
  for u in
    select au.* from auth.users au
    where not exists (select 1 from public.profiles p where p.user_id = au.id)
    order by au.created_at
  loop
    base := public.kfp_normalize_username(
              coalesce(nullif(u.raw_user_meta_data->>'username', ''),
                       split_part(coalesce(u.email, ''), '@', 1)));
    base := left(base, 32);
    if length(base) < 3 then base := 'user'; end if;
    uname := base; n := 0;
    while exists (select 1 from public.profiles where username = uname) loop
      n := n + 1;
      uname := left(base, 25) || '-' || substr(replace(u.id::text, '-', ''), n, 6);
      exit when n > 20;
    end loop;
    nick := left(coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), uname), 60);

    insert into public.profiles (user_id, username, nickname, email, is_legacy_email,
                                 email_verified_at, last_login_at, created_at)
    values (u.id, uname, nick, u.email,
            coalesce(u.email, '') ilike '%@kfp.example.com',
            u.email_confirmed_at, u.last_sign_in_at, coalesce(u.created_at, now()))
    on conflict (user_id) do nothing;
    raise notice 'profile backfilled: % → %', u.id, uname;
  end loop;
end;
$$;
