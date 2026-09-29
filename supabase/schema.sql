-- Schema for the restaurant-radio cloud backend.
-- Run once against a fresh Supabase project (also available via the
-- Supabase MCP tool `execute_sql`).

-- Private bucket for song audio files (not public — files are only reachable
-- through short-lived signed URLs minted by the music-api Edge Function).
insert into storage.buckets (id, name, public)
values ('songs', 'songs', false)
on conflict (id) do nothing;

-- Single-shop data table: one row holds the passphrase hash + the full app
-- state (playlists, track metadata, settings) as JSON.
create table if not exists public.shop_data (
  key text primary key default 'main',
  passphrase_hash text,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.shop_data enable row level security;
-- No public policies: only the service role (used inside the Edge Function)
-- can read/write this table. The Edge Function is the sole gateway, gated
-- by the shop passphrase.
