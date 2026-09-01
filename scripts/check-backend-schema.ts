import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const migrationPath = resolve(root, "supabase/migrations/20260830155124_create_huddle_backend.sql");
const sql = await readFile(migrationPath, "utf8");

const requiredTables = [
  "profiles", "oauth_accounts", "organizations", "organization_members",
  "projects", "project_members", "rooms", "room_members", "room_invites",
  "document_revisions", "agent_jobs", "usage_events", "audit_events",
];

for (const table of requiredTables) {
  if (!new RegExp(`create table public\\.${table}\\b`, "i").test(sql)) throw new Error(`missing table: ${table}`);
  if (!new RegExp(`alter table public\\.${table} enable row level security`, "i").test(sql)) throw new Error(`RLS is not enabled for: ${table}`);
}

for (const marker of [
  "revoke all on all tables in schema public from anon",
  "revoke all on all functions in schema private from public, anon, authenticated",
  "unique (room_id, content_hash)",
  "idempotency_key text not null unique",
  "security definer",
  "set search_path = public, pg_temp",
  "create trigger on_organization_created",
  "create policy revisions_select",
  "create policy audit_select",
]) {
  if (!sql.toLowerCase().includes(marker.toLowerCase())) throw new Error(`missing control: ${marker}`);
}

if (/service_role|client_secret|password\s*=\s*['"]/.test(sql)) throw new Error("secret-like value found in migration");

console.log("backend schema verification passed");
