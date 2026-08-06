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

-- Meal photos live in a public Storage bucket. Unlike the tables above, this
-- whole section is idempotent — safe to re-run against a live project, and
-- re-running is how a deployed database converges on policy changes.
--
-- public = true serves objects at their public URL without RLS, so no select
-- policy exists — one would only grant anonymous listing of the bucket (an
-- earlier revision had exactly that; the drop below retires it). The bucket
-- caps uploads at 512KB JPEG: the app resizes to ~30-50KB, the cap backstops
-- anyone hitting the Storage API directly with household credentials.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meal-images', 'meal-images', true, 524288, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "anyone can view meal images" on storage.objects;

drop policy if exists "authenticated can upload meal images" on storage.objects;
create policy "authenticated can upload meal images" on storage.objects
  for insert to authenticated with check (bucket_id = 'meal-images');

-- delete exists so a failed add-meal can reclaim the photo it just uploaded
drop policy if exists "authenticated can remove meal images" on storage.objects;
create policy "authenticated can remove meal images" on storage.objects
  for delete to authenticated using (bucket_id = 'meal-images');
