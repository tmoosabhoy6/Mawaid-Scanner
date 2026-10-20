# Cloudflare free deployment

One Worker serves the printing/admin app at `/` and the gate app at `/scanner`. One D1 database makes admissions consistent across all four phones. No paid Render service, custom domain, R2 bucket or browser-rendering service is required.

The pinned official `cf` CLI and Vite plugin are beta releases. This project uses `cloudflare.config.ts`; do not generate a separate Wrangler configuration.

## Connected Git builds

The connected Worker is `mawaid-scanner` and its shared database is `mawayid-karbala` (the database keeps its original name; renaming it would create a different, empty database). Cloudflare's Git build settings must use:

- Branch: `main`
- Root directory: `/`
- Build command: `npm run build:cloudflare`
- Deploy command: `npx cf deploy --mode production --prebuilt`

The default `npx wrangler deploy` does not read this project's `cloudflare.config.ts`. Runtime secrets belong in the Worker's Variables and Secrets settings, not in the public repository. The database UUID in the committed configuration is public configuration, not a credential.

## Publish

Use Node 24 or newer. Connect the installed Cloudflare plugin to the intended account, or authenticate the CLI on a computer with access to Cloudflare:

```sh
npm ci
npx cf auth login
npx cf auth whoami
npx cf d1 list --name mawayid-karbala
```

Reuse an existing database with that name. If none exists, create it once:

```sh
npx cf d1 create --name mawayid-karbala
```

Copy the returned database UUID into the `DB` binding in `cloudflare.config.ts`, as `bindings.d1({id:'THE_RETURNED_UUID',name:'mawayid-karbala'})`. Do not invent an ID or create another database on each deployment. The existing account's observed UUID is already recorded. Check that `mawaid-scanner` is the intended Worker before deploying to that name.

Apply the migration to that exact database UUID before publishing:

```sh
npx cf d1 migrations apply THE_RETURNED_UUID --dir cloudflare/migrations
```

Prepare a private, git-ignored `.dev.vars` file. Use distinct random values for all three entries; there are no default passwords:

```dotenv
ADMIN_PASSWORD=YOUR_RANDOM_ADMIN_PASSWORD_AT_LEAST_12_CHARACTERS
SCANNER_PASSWORD=YOUR_DIFFERENT_RANDOM_SCANNER_PASSWORD_AT_LEAST_12_CHARACTERS
SYNC_TOKEN=YOUR_SEPARATE_RANDOM_TOKEN_AT_LEAST_32_CHARACTERS
```

Keep a private copy in your password manager. The sync token also encrypts unfinished label manifests; finish pending PDFs before rotating it. Upload the secrets with the deployment:

```sh
npm run build:cloudflare
npx cf deploy --mode production --dry-run --prebuilt
npx cf deploy --mode production --prebuilt --secrets-file .dev.vars
```

Use the actual `workers.dev` URL returned by deployment. Check `/api/health`, then sign in at `/` with the admin password and `/scanner` with the scanner password. Do not publish test passwords or send credentials to GitHub. Keep the account on the free plan unless you deliberately choose to upgrade.

## Printing and recovery

PDF generation runs on the printing computer to avoid the free Worker's 10 ms CPU limit. The Worker allocates cards and saves an encrypted recovery manifest; the browser generates and uploads a PDF before QZ Tray receives the print job. Print jobs contain at most 100 labels and continue in batches for larger groups. There is no lifetime lost-card replacement cap.

If PDF generation or upload is interrupted, open **Print log → Finish PDF**, then **Print PDF**. This reuses the issued QR codes. An allocation retry also reuses its request key. Do not issue replacements merely because a printer was offline. Saved PDFs cannot be overwritten by an upload retry.

Install the Zebra ZD220D driver and QZ Tray on the printing computer. Confirm the actual driver queue name in Settings and the **76.2 × 50.8 mm (3 × 2 inch)** label stock. Physical alignment, QZ permission prompts and phone-camera scanning still require an on-site test.

## Tours sync

Follow the [separate ToursSync setup](../README.md#separate-tours-sync--preserve-the-existing-flatten-automation), using the deployed HTTPS origin and this deployment's `SYNC_TOKEN`. That setup adds its own function and trigger and leaves the existing flatten script and trigger untouched. Pehli Ziyarat is arrival; actual departure is Wada plus one calendar day.

## Free-plan capacity and retention

The local Cloudflare runtime test creates 2,000 unique cards and accepts 6,000 meals through four concurrent clients. It verifies data consistency, not production CPU time or internet latency. Verify production invocation CPU and D1 usage in Cloudflare before the first full service.

Current free limits are 100,000 Worker requests/day, 10 ms CPU/invocation, 5 million D1 rows read/day, 100,000 rows written/day and 500 MB per D1 database (5 GB across the account). Index updates count toward writes. Four phones polling service status every 15 seconds all day use about 23,040 requests, plus up to 6,000 accepted scans and administrative work. Duplicate scans and retries also count. Unchanged five-minute syncs skip tour-row writes.

Saved PDFs, encrypted pending jobs, cards, indexes and scan history all consume storage. Settings displays database usage and offers **Archive & clear** and **Delete without archiving** (see the [main README](../README.md#storage-archive-and-clear)). Nothing is deleted automatically. Clearing removes scan records and meals served dated before a chosen date, never today's, and the PDFs of stays that have departed. It runs in bounded chunks and stops after 40,000 rows written per UTC day, leaving the rest of the 100,000 daily free writes for scanning. Freed pages are reused by new records. Check Cloudflare's usage dashboard regularly.

Use D1's database export in the Cloudflare dashboard before schema changes and for regular off-site backups. Protect exports because they contain recoverable label PDFs. The in-app archive is a readable record, not a restorable backup. A new database must not be substituted for the current one during live service.

Quota references: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
