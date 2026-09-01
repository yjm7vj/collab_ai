# Huddle.AI backend

This directory contains the versioned Supabase control-plane schema for the
application. The migration is additive and does not alter existing Cloudflare
Durable Object room storage.

## Ownership model

- Supabase PostgreSQL owns global identity, organizations, projects, room
  directory data, memberships, immutable revision metadata, agent jobs, usage,
  and audit events.
- The Cloudflare Durable Object for each room owns live WebSocket coordination,
  presence, message ordering, and transient room state.
- Large document snapshots and exports belong in object storage. PostgreSQL
  stores their object key, hash, and size.

## Secrets and environments

Do not place service-role keys, OAuth secrets, database passwords, or signing
keys in this directory. Local secrets belong in ignored environment files, and
deployment secrets belong in Supabase or Cloudflare secret storage.

The local project id is `collab_ai`. Production linking and applying migrations
are deliberately separate operations so a local schema check cannot silently
change production.
