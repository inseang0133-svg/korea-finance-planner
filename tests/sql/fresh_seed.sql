-- a member from before the SaaS upgrade: old fake e-mail, Cloud data incl. gold (raw localStorage strings)
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
values ('e1000000-0000-0000-0000-000000000001', 'old@kfp.example.com', now(), '{"username":"old"}');
insert into public.user_data (user_id, data)
values ('e1000000-0000-0000-0000-000000000001', jsonb_build_object('salary', '2500000', 'kfp_gold_lots_v1', '[{"id":"g1","grams":1,"costThb":3000}]'));

-- production reality: accounts created while auth.users had NO profile trigger → no profiles row
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
values ('e1000000-0000-0000-0000-000000000002', 'noprofile@kfp.example.com', now(), '{}'),
       ('e1000000-0000-0000-0000-000000000003', 'real.person@gmail.com', now(), '{}');
delete from public.profiles where user_id in ('e1000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000003');
