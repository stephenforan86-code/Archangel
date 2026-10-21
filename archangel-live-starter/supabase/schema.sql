-- Archangel starter schema (Supabase/PostgreSQL)
create extension if not exists pgcrypto;

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tradition text not null,
  source_type text not null default 'official',
  feed_url text not null unique,
  website_url text,
  enabled boolean not null default false,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.sources(id) on delete set null,
  external_id text,
  title text not null,
  summary text,
  story_url text not null unique,
  author text,
  published_at timestamptz,
  tradition text,
  content_type text not null default 'News coverage',
  summary_is_ai boolean not null default false,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(source_id, external_id)
);

create index if not exists stories_published_at_idx on public.stories(published_at desc nulls last);
create index if not exists stories_tradition_idx on public.stories(tradition);
create index if not exists sources_enabled_idx on public.sources(enabled) where enabled = true;

alter table public.sources enable row level security;
alter table public.stories enable row level security;

-- Public users can read published stories, but cannot edit sources or stories.
create policy "Public can read stories" on public.stories
  for select to anon, authenticated using (true);

create policy "Public can read enabled sources" on public.sources
  for select to anon, authenticated using (enabled = true);

-- No anonymous write policies are created. Ingestion uses the service-role key
-- inside the Edge Function only.
