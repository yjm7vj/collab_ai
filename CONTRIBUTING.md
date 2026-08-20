# Contributing

Thanks for helping with `collab_ai`. This project is a multiplayer AI workspace
built on React, Vite, Cloudflare Workers, and Durable Objects.

## Local Setup

```bash
npm install
```

Copy `.dev.vars.example` to `.dev.vars` and fill in the required secrets:

```bash
ANTHROPIC_API_KEY=sk-ant-...
ROOM_SECRET=some-long-random-string
```

Use `ANTHROPIC_API_KEY=mock` when you want to exercise the app without calling a
live model.

## Development

```bash
npm run dev
```

Open `http://localhost:5173`, create a room, and use a second browser window to
check the multiplayer flow.

## Checks

Run the focused checks before opening a pull request:

```bash
npm test
npm run typecheck
```

For Worker-level integration coverage, also run:

```bash
npm run test:integration
```

## Secrets

Do not commit `.dev.vars` or any private keys. The example file is safe to edit,
but real secret values should stay local or be stored with `wrangler secret put`
for deployed Workers.
