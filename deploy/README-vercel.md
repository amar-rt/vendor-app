# Deploying to Vercel

This app deploys to Vercel with the official [`@vercel/react-router`](https://vercel.com/docs/frameworks/frontend/react-router)
preset (already wired up in [react-router.config.ts](../react-router.config.ts)) — no Docker,
no CloudFormation, no manual server setup.

## 1. Connect the repo

In the [Vercel dashboard](https://vercel.com/new), import this GitHub repo. Vercel
auto-detects the React Router framework and needs no build command overrides — that's
also your CI/CD: every push to `main` triggers a production deploy, every other branch/PR
gets a preview deployment, automatically. No GitHub Actions workflow needed.

## 2. Set environment variables

In the project's **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Postgres connection string (see §3 below for pooling requirements) |
| `SHOPIFY_API_KEY` | Client ID from `shopify.app.toml` |
| `SHOPIFY_API_SECRET` | Client Secret from the Partner Dashboard / your app's API credentials |
| `SCOPES` | `read_products,write_products,read_inventory,write_inventory,read_locations,write_files` |
| `SHOPIFY_APP_URL` | Your Vercel production URL, e.g. `https://vendor-app.vercel.app` (fill in **after** the first deploy, once you know it — see §5) |
| `NODE_ENV` | `production` |

## 3. Postgres and connection pooling

Vercel Functions are serverless — each invocation can open its own database connection,
and under real traffic that adds up fast against Postgres's connection limit. Pick a
Postgres host with built-in connection pooling and use its **pooled** connection string
for `DATABASE_URL`:

- **Neon**: use the pooled connection string (has `-pooler` in the hostname)
- **Supabase**: use the "Transaction" pooler connection string (port 6543), not the direct one
- **RDS**: needs RDS Proxy in front of it for the same effect — more setup than the above

If your host gives you a separate pooled vs. direct connection string, Prisma supports
both at once via `directUrl` in [prisma/schema.prisma](../prisma/schema.prisma):

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")      // pooled — used at runtime
  directUrl = env("DIRECT_DATABASE_URL") // direct — used by `prisma migrate`
}
```

Only add `directUrl` if your host actually gives you two distinct connection strings.

## 4. Run migrations

Vercel's build step is not the place to run `prisma migrate deploy` — concurrent deploys
(e.g. a preview build running alongside a production build) could race against each
other on the same database. Run migrations manually, from your own machine, against the
**direct** (non-pooled) connection string:

```bash
DATABASE_URL="<direct connection string>" npx prisma migrate deploy
```

Do this once before the first deploy, and again after every schema change lands in `main`.

`postinstall` in `package.json` already runs `prisma generate` automatically on every
Vercel build — that's just regenerating the typed client from `prisma/schema.prisma`, not
touching the database, so it's safe to run on every build.

## 5. Point the app at its real URL

Shopify apps need a stable public URL for OAuth callbacks and webhooks. After the first
deploy:

1. Grab your production URL from the Vercel dashboard (or set up a custom domain).
2. Set `SHOPIFY_APP_URL` (step 2 above) to that URL, and redeploy.
3. Update `application_url` in [shopify.app.toml](../shopify.app.toml) to match, and run
   `npm run deploy` (Shopify CLI) to sync it to the Partner Dashboard / app config.

## 6. Custom app on the destination store

Nothing here changes based on hosting — the destination-store `client_credentials` OAuth
flow (Settings page in the app) works identically regardless of where the vendor app
itself is hosted.
