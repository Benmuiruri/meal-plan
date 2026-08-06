-- Weekly Meal & Shop — Supabase schema
-- Run once: Dashboard → SQL Editor → paste this whole file → Run.

-- Meals and breakfasts: your library
create table meals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  kind       text not null check (kind in ('main', 'breakfast')),
  image_url  text,
  tint       text,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);

-- Grocery staples with remembered prices
create table staples (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  last_price numeric(10,2),
  sort_order integer not null default 0
);

-- One row per week, draft or saved
create table weeks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  week_start    date not null,
  budget        numeric(10,2),
  status        text not null default 'draft' check (status in ('draft', 'saved')),
  picks         jsonb not null default '{"mains":[],"breakfasts":[]}',
  days          jsonb not null default '{}',
  groceries     jsonb not null default '[]',
  updated_at    timestamptz not null default now(),
  unique (user_id, week_start)
);

alter table meals   enable row level security;
alter table staples enable row level security;
alter table weeks   enable row level security;

-- (select auth.uid()) is evaluated once per query rather than once per row
create policy "own meals" on meals for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "own staples" on staples for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "own weeks" on weeks for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- weeks is covered by its unique (user_id, week_start) index
create index meals_user_id_idx   on meals   (user_id);
create index staples_user_id_idx on staples (user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger weeks_set_updated_at
  before update on weeks
  for each row execute function public.set_updated_at();

-- Meal photos live in a public Storage bucket: anyone with the URL can view
-- (the card grid loads them unauthenticated), only the household can upload.
insert into storage.buckets (id, name, public) values ('meal-images', 'meal-images', true)
on conflict (id) do nothing;

create policy "anyone can view meal images" on storage.objects
  for select using (bucket_id = 'meal-images');

create policy "authenticated can upload meal images" on storage.objects
  for insert to authenticated with check (bucket_id = 'meal-images');
