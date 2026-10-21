# Working on Mawaid

- **Always merge finished work into `main`** (fast-forward, or a merge commit if `main` has moved) and push. Cloudflare deploys `main` automatically; there is no need to check that a deploy went live.
- Deploying does not apply database migrations. When a change adds a file to `cloudflare/migrations`, apply it to the live D1 database `mawayid-karbala` (`0fa7988c-214c-475e-938f-2fb76e0b5c9c`) and record it in `d1_migrations` **before** merging, so the deployed code never meets an old schema. Back up affected tables first and give the user the backup.
- Run `npm run check`, `npm run build` and `npm test` before merging.
