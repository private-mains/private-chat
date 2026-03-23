# Deploy guide

## Important truth first
This app is packaged for a simple Cloudflare deployment, but a true D1 + R2 app is **not literally drag-and-drop only**. You still must create the D1 database, create the R2 bucket, paste their names/IDs into `wrangler.toml`, add the session secret, run the SQL migration, and deploy the Worker.

That is because Cloudflare bindings for D1 and R2 must be attached to the project before the app can work. Cloudflare documents that Workers can serve static assets and full-stack apps, and Pages/Functions can use D1, R2, and other bindings via config or the dashboard. citeturn392440search3turn392440search4turn392440search5

## Recommended deployment path
1. Create a new Cloudflare Worker.
2. Create a D1 database named `private-chat-db`.
3. Create an R2 bucket named `private-chat-files`.
4. Replace `database_id` in `apps/worker/wrangler.toml`.
5. In `apps/worker`, run:
   - `npm install`
   - `npx wrangler secret put SESSION_SECRET`
   - `npx wrangler d1 execute private-chat-db --file=./migrations/0001_init.sql --remote`
   - `npx wrangler deploy`
6. Open the deployed Worker URL.
7. Register your first account.
8. Promote the first account to admin manually with a D1 SQL update if you want admin access.

## Make first user admin
After creating your first account, run a D1 SQL update:

```sql
UPDATE users SET is_admin = 1 WHERE email = 'you@example.com';
```

## Allowed files
- jpg
- png
- webp
- gif
- pdf
- txt

Max size: `3145728` bytes.
