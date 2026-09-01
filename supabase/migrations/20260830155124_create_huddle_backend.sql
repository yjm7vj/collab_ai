-- Huddle.AI scalable backend foundation.
--
-- Supabase owns global control-plane data. Live room coordination remains in
-- the Cloudflare Durable Object for that room. Large document bodies should
-- be stored in object storage; this schema stores immutable metadata and
-- content hashes, not unbounded blobs.

create extension if not exists pgcrypto;

create schema if not exists private;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  legacy_uid text unique,
  display_name text not null default 'User' check (char_length(display_name) between 1 and 120),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 1024),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.oauth_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (provider in ('google', 'github')),
  provider_account_id text not null check (char_length(provider_account_id) between 1 and 512),
  created_at timestamptz not null default now(),
  unique (provider, provider_account_id),
  unique (user_id, provider)
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 160),
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (organization_id, user_id)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 160),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (project_id, user_id)
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  room_key text not null unique check (char_length(room_key) between 8 and 128),
  project_id uuid references public.projects (id) on delete set null,
  owner_id uuid not null references public.profiles (id) on delete restrict,
  title text not null default 'Untitled room' check (char_length(title) between 1 and 160),
  visibility text not null default 'invite' check (visibility in ('open', 'invite', 'locked')),
  durable_object_key text not null unique check (char_length(durable_object_key) between 1 and 256),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz,
  removed_at timestamptz,
  primary key (room_id, user_id)
);

create table public.room_invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  code_hash text not null unique check (char_length(code_hash) between 32 and 256),
  role text not null default 'editor' check (role in ('admin', 'editor', 'viewer')),
  max_uses integer check (max_uses is null or max_uses between 1 and 1000000),
  uses integer not null default 0 check (uses >= 0),
  expires_at timestamptz,
  created_by uuid not null references public.profiles (id) on delete restrict,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.document_revisions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  author_user_id uuid not null references public.profiles (id) on delete restrict,
  revision_number bigint not null check (revision_number > 0),
  parent_revision_id uuid references public.document_revisions (id) on delete restrict,
  object_key text,
  content_hash text not null check (char_length(content_hash) between 32 and 256),
  byte_size bigint check (byte_size is null or byte_size >= 0),
  created_at timestamptz not null default now(),
  unique (room_id, revision_number),
  unique (room_id, content_hash)
);

create table public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.rooms (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  requested_by uuid not null references public.profiles (id) on delete restrict,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  provider text check (provider is null or char_length(provider) between 1 and 80),
  model text check (model is null or char_length(model) between 1 and 160),
  input jsonb not null default '{}'::jsonb,
  result_metadata jsonb not null default '{}'::jsonb,
  error_code text,
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 256),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (room_id is not null or project_id is not null)
);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  room_id uuid references public.rooms (id) on delete set null,
  user_id uuid references public.profiles (id) on delete set null,
  agent_job_id uuid references public.agent_jobs (id) on delete set null,
  provider text not null check (char_length(provider) between 1 and 80),
  model text not null check (char_length(model) between 1 and 160),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_tokens bigint not null default 0 check (cache_tokens >= 0),
  cost_usd numeric(20, 8) not null default 0 check (cost_usd >= 0),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 256),
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  room_id uuid references public.rooms (id) on delete set null,
  actor_user_id uuid references public.profiles (id) on delete set null,
  action text not null check (char_length(action) between 1 and 120),
  target_type text check (target_type is null or char_length(target_type) between 1 and 80),
  target_id text check (target_id is null or char_length(target_id) between 1 and 256),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index organization_members_user_idx on public.organization_members (user_id) where removed_at is null;
create index project_members_user_idx on public.project_members (user_id) where removed_at is null;
create index rooms_project_idx on public.rooms (project_id) where archived_at is null;
create index rooms_owner_idx on public.rooms (owner_id, updated_at desc);
create index room_members_user_idx on public.room_members (user_id, last_seen_at desc) where removed_at is null;
create index room_members_room_idx on public.room_members (room_id, role) where removed_at is null;
create index revisions_room_author_idx on public.document_revisions (room_id, author_user_id, created_at desc);
create index jobs_requester_idx on public.agent_jobs (requested_by, created_at desc);
create index jobs_queue_idx on public.agent_jobs (status, created_at) where status in ('queued', 'running');
create index usage_org_idx on public.usage_events (organization_id, created_at desc);
create index audit_room_idx on public.audit_events (room_id, created_at desc);
create index audit_actor_idx on public.audit_events (actor_user_id, created_at desc);

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at before update on public.profiles for each row execute function private.touch_updated_at();
create trigger organizations_touch_updated_at before update on public.organizations for each row execute function private.touch_updated_at();
create trigger projects_touch_updated_at before update on public.projects for each row execute function private.touch_updated_at();
create trigger rooms_touch_updated_at before update on public.rooms for each row execute function private.touch_updated_at();

create or replace function private.handle_new_organization()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.organization_members (organization_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (organization_id, user_id) do update set role = 'owner', removed_at = null;
  return new;
end;
$$;

revoke all on function private.handle_new_organization() from public, anon, authenticated;
create trigger on_organization_created after insert on public.organizations for each row execute function private.handle_new_organization();

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(nullif(left(new.raw_user_meta_data ->> 'name', 120), ''), nullif(left(new.raw_user_meta_data ->> 'full_name', 120), ''), 'User'),
    nullif(left(new.raw_user_meta_data ->> 'avatar_url', 1024), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_auth_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_auth_user();

create or replace function private.current_user_is_org_member(p_org_id uuid, p_roles text[] default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.organization_members om
    where om.organization_id = p_org_id
      and om.user_id = (select auth.uid())
      and om.removed_at is null
      and (p_roles is null or om.role = any (p_roles))
  );
$$;

create or replace function private.current_user_is_project_member(p_project_id uuid, p_roles text[] default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.project_members pm
    where pm.project_id = p_project_id
      and pm.user_id = (select auth.uid())
      and pm.removed_at is null
      and (p_roles is null or pm.role = any (p_roles))
  ) or exists (
    select 1 from public.projects owner_project
    where owner_project.id = p_project_id
      and owner_project.owner_id = (select auth.uid())
      and (p_roles is null or p_roles && array['owner', 'admin'])
  ) or exists (
    select 1 from public.projects p
    where p.id = p_project_id
      and p.organization_id is not null
      and (p_roles is null or p_roles && array['owner', 'admin'])
      and private.current_user_is_org_member(p.organization_id, null)
  );
$$;

create or replace function private.current_user_is_room_member(p_room_id uuid, p_roles text[] default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.room_members rm
    where rm.room_id = p_room_id
      and rm.user_id = (select auth.uid())
      and rm.removed_at is null
      and (p_roles is null or rm.role = any (p_roles))
  ) or exists (
    select 1 from public.rooms owner_room
    where owner_room.id = p_room_id
      and owner_room.owner_id = (select auth.uid())
      and (p_roles is null or p_roles && array['owner', 'admin'])
  ) or exists (
    select 1
    from public.rooms r
    where r.id = p_room_id
      and r.project_id is not null
      and private.current_user_is_project_member(r.project_id, null)
  );
$$;

create or replace function private.current_user_can_see_profile(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id = (select auth.uid())
    or exists (
      select 1
      from public.room_members mine
      join public.room_members theirs on theirs.room_id = mine.room_id
      where mine.user_id = (select auth.uid())
        and mine.removed_at is null
        and theirs.user_id = p_user_id
        and theirs.removed_at is null
    );
$$;

revoke all on all functions in schema private from public, anon, authenticated;

alter table public.profiles enable row level security;
alter table public.oauth_accounts enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_invites enable row level security;
alter table public.document_revisions enable row level security;
alter table public.agent_jobs enable row level security;
alter table public.usage_events enable row level security;
alter table public.audit_events enable row level security;

revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;

create policy profiles_select on public.profiles for select to authenticated using (private.current_user_can_see_profile(id));
create policy profiles_update on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy oauth_accounts_select on public.oauth_accounts for select to authenticated using (user_id = (select auth.uid()));

create policy organizations_select on public.organizations for select to authenticated using (private.current_user_is_org_member(id, null));
create policy organizations_insert on public.organizations for insert to authenticated with check (created_by = (select auth.uid()));
create policy organizations_update on public.organizations for update to authenticated using (private.current_user_is_org_member(id, array['owner', 'admin'])) with check (private.current_user_is_org_member(id, array['owner', 'admin']));
create policy organizations_delete on public.organizations for delete to authenticated using (private.current_user_is_org_member(id, array['owner']));

create policy organization_members_select on public.organization_members for select to authenticated using (user_id = (select auth.uid()) or private.current_user_is_org_member(organization_id, array['owner', 'admin']));
create policy organization_members_insert on public.organization_members for insert to authenticated with check (private.current_user_is_org_member(organization_id, array['owner', 'admin']));
create policy organization_members_update on public.organization_members for update to authenticated using (private.current_user_is_org_member(organization_id, array['owner', 'admin'])) with check (private.current_user_is_org_member(organization_id, array['owner', 'admin']));
create policy organization_members_delete on public.organization_members for delete to authenticated using (private.current_user_is_org_member(organization_id, array['owner']));

create policy projects_select on public.projects for select to authenticated using (owner_id = (select auth.uid()) or private.current_user_is_project_member(id, null));
create policy projects_insert on public.projects for insert to authenticated with check (owner_id = (select auth.uid()) and (organization_id is null or private.current_user_is_org_member(organization_id, array['owner', 'admin'])));
create policy projects_update on public.projects for update to authenticated using (owner_id = (select auth.uid()) or private.current_user_is_project_member(id, array['owner', 'admin'])) with check (owner_id = (select auth.uid()) or private.current_user_is_project_member(id, array['owner', 'admin']));
create policy projects_delete on public.projects for delete to authenticated using (owner_id = (select auth.uid()) or private.current_user_is_project_member(id, array['owner']));

create policy project_members_select on public.project_members for select to authenticated using (user_id = (select auth.uid()) or private.current_user_is_project_member(project_id, array['owner', 'admin']));
create policy project_members_insert on public.project_members for insert to authenticated with check (private.current_user_is_project_member(project_id, array['owner', 'admin']));
create policy project_members_update on public.project_members for update to authenticated using (private.current_user_is_project_member(project_id, array['owner', 'admin'])) with check (private.current_user_is_project_member(project_id, array['owner', 'admin']));
create policy project_members_delete on public.project_members for delete to authenticated using (private.current_user_is_project_member(project_id, array['owner']));

create policy rooms_select on public.rooms for select to authenticated using (owner_id = (select auth.uid()) or private.current_user_is_room_member(id, null));
create policy rooms_insert on public.rooms for insert to authenticated with check (owner_id = (select auth.uid()) and (project_id is null or private.current_user_is_project_member(project_id, array['owner', 'admin', 'editor'])));
create policy rooms_update on public.rooms for update to authenticated using (owner_id = (select auth.uid()) or private.current_user_is_room_member(id, array['owner', 'admin'])) with check (owner_id = (select auth.uid()) or private.current_user_is_room_member(id, array['owner', 'admin']));
create policy rooms_delete on public.rooms for delete to authenticated using (owner_id = (select auth.uid()) or private.current_user_is_room_member(id, array['owner']));

create policy room_members_select on public.room_members for select to authenticated using (user_id = (select auth.uid()) or private.current_user_is_room_member(room_id, array['owner', 'admin']));
create policy room_members_insert on public.room_members for insert to authenticated with check (private.current_user_is_room_member(room_id, array['owner', 'admin']));
create policy room_members_update on public.room_members for update to authenticated using (private.current_user_is_room_member(room_id, array['owner', 'admin'])) with check (private.current_user_is_room_member(room_id, array['owner', 'admin']));
create policy room_members_delete on public.room_members for delete to authenticated using (private.current_user_is_room_member(room_id, array['owner', 'admin']));

create policy room_invites_select on public.room_invites for select to authenticated using (private.current_user_is_room_member(room_id, array['owner', 'admin']));
create policy room_invites_insert on public.room_invites for insert to authenticated with check (created_by = (select auth.uid()) and private.current_user_is_room_member(room_id, array['owner', 'admin']));
create policy room_invites_update on public.room_invites for update to authenticated using (private.current_user_is_room_member(room_id, array['owner', 'admin'])) with check (private.current_user_is_room_member(room_id, array['owner', 'admin']));

create policy revisions_select on public.document_revisions for select to authenticated using (author_user_id = (select auth.uid()) or private.current_user_is_room_member(room_id, array['owner', 'admin']));
create policy revisions_insert on public.document_revisions for insert to authenticated with check (author_user_id = (select auth.uid()) and private.current_user_is_room_member(room_id, array['owner', 'admin', 'editor']));

create policy agent_jobs_select on public.agent_jobs for select to authenticated using (requested_by = (select auth.uid()) or (room_id is not null and private.current_user_is_room_member(room_id, array['owner', 'admin'])) or (project_id is not null and private.current_user_is_project_member(project_id, array['owner', 'admin'])));
create policy agent_jobs_insert on public.agent_jobs for insert to authenticated with check (requested_by = (select auth.uid()) and ((room_id is not null and private.current_user_is_room_member(room_id, null)) or (project_id is not null and private.current_user_is_project_member(project_id, null))));

create policy usage_select on public.usage_events for select to authenticated using (user_id = (select auth.uid()) or (organization_id is not null and private.current_user_is_org_member(organization_id, array['owner', 'admin'])));

create policy audit_select on public.audit_events for select to authenticated using (actor_user_id = (select auth.uid()) or (organization_id is not null and private.current_user_is_org_member(organization_id, array['owner', 'admin'])) or (room_id is not null and private.current_user_is_room_member(room_id, array['owner', 'admin'])) or (project_id is not null and private.current_user_is_project_member(project_id, array['owner', 'admin'])));

comment on schema private is 'Internal security-definer helpers. Do not expose through the Supabase Data API.';
comment on table public.oauth_accounts is 'Provider account mapping. Server-side access only; provider secrets are never stored here.';
comment on table public.document_revisions is 'Immutable revision metadata. Store large snapshots in R2 or Supabase Storage and retain only object_key/hash here.';
comment on table public.audit_events is 'Append-only application audit stream. Inserts are intentionally server-side only.';
