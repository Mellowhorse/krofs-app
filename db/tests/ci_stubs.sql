-- ============================================================================
-- CI stubs — plain Postgres lacks Supabase's auth schema and roles.
-- Run BEFORE db/001. Never run against a real Supabase project.
-- ============================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- Supabase's auth.uid(); returns null in CI (no session).
create or replace function auth.uid()
returns uuid language sql stable as $$ select null::uuid $$;

-- Roles referenced by the RLS policies in db/001.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

-- gen_random_uuid/digest live in pgcrypto; db/001 creates it, but the stub
-- table above already needs it.
create extension if not exists pgcrypto;
