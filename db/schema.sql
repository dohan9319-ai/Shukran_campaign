-- =====================================================================
-- شكراً معالي الوزير — Postgres schema (Railway)
-- Applied by the campaign team; the Node backend (server.js) is the only
-- client. Moderation happens via the token-protected /admin page.
-- NOTE: this replaced the original Supabase schema when the project
-- moved to Railway Postgres (2026-07-15).
-- =====================================================================

create table if not exists restaurants (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  name_en text,
  logo_bytes bytea not null,          -- logo stored in-db (<= 2 MB, validated server-side)
  logo_mime text not null check (logo_mime in ('image/png','image/jpeg','image/svg+xml')),
  contact_name text not null,         -- private
  message text check (char_length(message) <= 280),
  status text not null default 'pending'
         check (status in ('pending','approved','rejected')),
  created_at timestamptz default now()
);

create index if not exists idx_restaurants_status_created
  on restaurants (status, created_at);
