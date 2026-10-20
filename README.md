# Mawaid — Faiz-e-Husaini Karbala

A shared meal-card system with a printing/admin interface at `/` and a camera/USB scanner at `/scanner`. All phones and the printing computer use the same HTTPS server and database. The scanner never grants offline admission.

The Cloudflare deployment serves **both apps from one Worker**, using D1 for shared meal counts. See [Cloudflare setup](cloudflare/README.md) for the free-plan deployment, database migration, secrets and backup instructions. The Node server remains available for local testing or a persistent server.

## Implemented rules

- **Green**: active, recognised card; current date falls within arrival and departure, inclusive; current meal is open; this person has not used that meal today.
- **Red**: unknown/replaced card, future arrival, expired departure, duplicate meal, withdrawn tour, person above updated PAX, or closed service. Network failure blocks admission.
- Karbala time (`Asia/Baghdad`): breakfast **06:30–09:00**, lunch **12:30–15:00**, dinner **19:00–21:30**. Start is included; end is excluded. At exactly 09:00 breakfast is closed. Outside service, camera and manual scanning are disabled. Launch cutoff is **21 October 2026**; stays arriving earlier and departing on/after the cutoff are included.
- One person has one entitlement for each meal per day. A database transaction and a unique `(person, date, meal)` key protect simultaneous scans across devices.
- QR tokens are independent random 256-bit values with no personal data. Token hashes and saved PDFs are retained. Cloudflare also keeps an encrypted label manifest until the printing computer saves its PDF, allowing interrupted jobs to recover. PDFs contain recoverable QR codes and require administrator access. QR codes and the calligraphy are drawn as vectors, so a label adds about 2.5 KB to its PDF.
- **No lifetime lost-card replacement cap.** Select the original person(s), generate fresh QR codes, and revoke their previous cards. Their consumed meals remain consumed. A 50-person tour with five replacements still has 50 people. The printed person number identifies the slot whose card is being replaced.
- Re-entering an existing tour ID and arrival date finds that stay instead of creating extra meal capacity. The same external tour ID can be used for another stay with another arrival date. “Submit & print” on an existing stay opens its replacement selection. This preserves the requested duplicate-ID workflow without turning lost cards into extra people.
- Label PDFs are saved before a print attempt. A failed printer connection can be retried from Print log without issuing new QR codes. An old PDF can contain revoked codes; reprinting never reactivates them. No dashboard or tour-edit screen is included.
- A replacement records the card the operator saw. If another operator replaced that card first, the second request is refused instead of revoking the newer card.

## Current verification and remaining setup

The code is implemented and covered by automated API, date-boundary, concurrency, replacement, parser and DOM integration tests. `scripts/verify_labels.py` additionally decodes all 50 generated PDF labels after rasterizing at the ZD220D's 203 dpi.

**This repository is not a deployed or hardware-certified installation.** No live Google Sheet values, existing Apps Script code, or existing triggers were changed. No phone camera or physical printer is available in this workspace, and no connected browser-control tool is available. DOM tests exercise the real client and API; hardware tests still need to run at the site.

Before going live:

1. Deploy the Cloudflare Worker with D1 using [these instructions](cloudflare/README.md), or use the persistent Node server below. Configure the three secrets. Cloudflare uses D1; the Node server's SQLite file requires a persistent disk.
2. Labels default to the confirmed **3 inch width × 2 inch height (76.2 × 50.8 mm)**, with the QR on the left and the Karbala al-Mualla calligraphy above the guest details on the right. Verify the computer’s exact printer name in Settings. Other supported labels are 40–104 mm wide and 50.8–200 mm high; labels below 80 mm high need at least 70 mm width.
3. The confirmed source mapping is **arrival = Pehli Ziyarat**, **departure = Wada Ziyarat + one calendar day**. Departure remains included in meal eligibility. Manually entered tours use the actual departure date directly; no extra day is added to manual entries.
4. Install the separate Apps Script file and its trigger as described below. The connected Google Sheets tools can read the spreadsheet but cannot install Apps Script code or triggers.
5. Install the Zebra driver and QZ Tray on the USB-connected printing computer; verify the connection/operating system. Run one physical print and scan it using the actual gate phone, then scan it again to verify a red result. Verify the next meal separately.
6. The sticker header is a vector trace of the supplied كربلاء المعلى artwork (`src/karbala-calligraphy.js`), in maroon `#741505`, followed by **FAIZ-E-HUSAINI**. Check one physical sticker: the ZD220D prints it in black.

The Zebra **ZD220D is a monochrome direct-thermal printer**. The saved PDF shows the calligraphy and border in maroon; this printer's stickers are black. Ordinary browsers cannot silently command a USB printer. QZ Tray bridges the browser to the driver; without a trusted signing certificate it prompts for approval. Silent trusted printing requires QZ's signed-message setup and a private signing key kept server-side. This app currently uses QZ's explicit approval flow.

## Storage: archive and clear

Settings → **Free hosting storage** shows database use against the 500 MB D1 limit. Nothing is deleted automatically. Choose a date, then:

- **Archive & clear** copies records to this computer, then clears them from the database. In Chrome or Edge, the first archive asks for a location and creates a **Mawaid Archive** folder there; the browser remembers it, and every archive becomes its own folder inside it (for example `Mawaid Archive/Archive 2026-11-02 21.40`). Other browsers download the same folder as a `.zip` file.
- **Delete without archiving** clears the same records after a confirmation.

Each archive folder holds `scan-log.csv`, `meals-served.csv`, `daily-meal-summary.csv`, `tours.csv`, `cards.csv`, `print-log.csv` and `read-me.txt`. Label PDFs are never archived.

Clearing removes scan records and meals served dated **before** the chosen date, and the saved label PDFs of stays that departed before it. The date can be today at the latest, so today's admissions always remain and a guest can never receive a second meal. Tours, people and cards stay, so replacements keep working; a cleared PDF shows as **PDF cleared** in Print log.

Cloudflare counts every deleted row and index entry as a database write (100,000 per day on the free plan, reset at 03:00 Karbala time). Clearing runs in small chunks and stops for the day after 40,000 writes, so scanning keeps the rest. A very large clean-up resumes the next day. Archive again before continuing; each archive is a complete snapshot of what remains.

## Run locally

Use Node.js **24 or later** (the server uses Node's built-in SQLite API):

```sh
npm ci
npm run build
cp .env.example .env
# Edit .env and set strong, distinct ADMIN_PASSWORD and SCANNER_PASSWORD.
# Set SYNC_TOKEN to a separately generated random secret of at least 32 characters.
npm start
```

For local verification use `APP_ORIGIN=http://localhost:3000`. HTTP localhost supports local camera access. Phones accessing another machine require a real HTTPS origin; phone `localhost` refers to the phone itself.

Open the admin page and sign in as Administrator. Open `/scanner` on gate phones and use the Scanner password. Scanner accounts cannot view tours, PDFs, settings, or scan logs. Sessions expire after 12 hours. There is no default password.

## Alternative: deploy the Node server

Use a single Node process with persistent storage; the SQLite file and its WAL must live together on the same mounted disk. Multiple stateless replicas with separate disks would create independent meal counts and are unsupported.

The Dockerfile builds bundled camera and printer libraries; the running app does not depend on a public JavaScript CDN. `compose.yaml` mounts the database volume and binds port 3000 only on loopback. Set `APP_ORIGIN=https://YOUR_REAL_HOSTNAME`, `TRUST_PROXY=1` for one trusted proxy, and strong secrets in `.env`, then:

```sh
docker compose up -d --build
```

Put a TLS reverse proxy in front of `127.0.0.1:3000`. For example, a Caddy host block for your real hostname can use `reverse_proxy 127.0.0.1:3000`. Keep the server clock synchronized. The health endpoint is `/api/health`.

Use online SQLite backups, including the WAL, rather than copying just the live database file:

```sh
node --env-file=.env scripts/backup.js /SAFE_BACKUP_DIRECTORY/mawayid.sqlite
# The database file keeps its original mawayid.sqlite name so existing installations keep their data.
```

For restoration, stop the server, restore the backup as `DATA_DIR/mawayid.sqlite`, remove leftover `mawayid.sqlite-wal` and `mawayid.sqlite-shm` files from the stopped installation, then restart. Keep backups private because the database includes label PDFs and admissions. Persist `.data` across deploys; restarting must not reset meal usage.

## Separate Tours sync — preserve the existing flatten automation

The verified workbook is `12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE`. Its source is **KRB - 25**, destination **Tours**, and existing search output **DB_SEARCHABLE**. `Tours` was empty when inspected. No writes were made to it by this implementation.

`apps-script/ToursSync.js` reads the main source independently; it does not call or edit `flattenZiyaratSchedule`, `runFlatten_`, their helpers, `doGet`, or `DB_SEARCHABLE`. All added global names start with `MAWAYID_` (the original prefix is kept so installed triggers and Script Properties keep working). It creates a separate five-minute `MAWAYID_refreshTours` trigger and never deletes or changes an existing trigger. Run setup as the spreadsheet owner once; other users should not install duplicate triggers.

With the confirmed arrival and departure mapping:

1. Open the spreadsheet's **Extensions → Apps Script**. Add a **new script file** named `ToursSync`. Paste `apps-script/ToursSync.js` into it. Leave existing files untouched.
2. Under **Project Settings → Script Properties**, add:
   - `MAWAYID_APP_URL`: the deployed app's HTTPS origin, without a trailing slash.
   - `MAWAYID_SYNC_TOKEN`: the server's `SYNC_TOKEN`.
3. Check `MAWAYID_CONFIG` if your source layout has changed. Live inspection found arrival IDs in **B**, office in **C**, PAX in **E**; Wada IDs in **Q**, office in **R**, PAX in **T**. Merged date headings are parsed without expanding or altering merged cells.
4. Run **MAWAYID_setupTours** manually once and authorise it. It validates, builds `Tours`, and sends a successful authenticated update before installing its own trigger. Existing trigger IDs are never touched.
5. In the app's Settings, verify the workbook URL and destination tab. Tab names populate after the first successful sync. An alternative destination must be empty or have the exact Tours output headers. The source and `DB_SEARCHABLE` are blocked as destinations.
6. Leave daily times blank for five-minute sync, or enter `HH:mm` times in Settings for daily scheduled syncs. Daily times run on the next five-minute trigger tick. **Request sync** bypasses the daily schedule on the next trigger tick; it is not an immediate browser pull.

The output columns are `Tour ID`, `Tour Name`, `Arrival Date`, `Departure Date`, `PAX Count`. The script includes complete stays ending on or after **2026-10-21**, including guests already present at launch and guests whose Wada is 20 October but who depart on 21 October. It pairs each arrival with one Wada date, adds one calendar day to compute departure (including month/year rollovers), rejects overlapping stays, handles repeated visits, and excludes incomplete/ambiguous stays or PAX mismatches with warnings. Malformed rows, conflicting duplicates and unexpected headers abort instead of replacing data with an untrusted result. The app displays warnings and the last successful sync time.

Import is transactional and idempotent. It updates matching stays without replacing their cards or history. A decreased PAX blocks higher numbered people. A tour omitted from a successful authoritative snapshot is marked inactive and its cards turn red. An arrival-date correction overlapping an existing stay is rejected to avoid creating duplicate entitlements. Reconcile ambiguous stays in the source rather than generating extra tours.

Tours sync is periodic; scanner admissions and printing changes share the same live database immediately. If no Wada date exists, the app does not guess a departure date or an unlimited stay. Manual tour entry remains available with verified dates.

## Verification

```sh
npm run check
npm run build
npm test
```

API and client tests cover three meal windows and their exact boundaries, Karbala date rollover, invalid dates/PAX, inclusive stay dates, one admission under simultaneous scans, daily/meal resets, five replacements in a 50-person group, repeated replacements without a lifetime cap, revoked codes, preserved meal history, idempotent retries, competing print operators, source changes/removals, roles, CSRF, output escaping, filters, bulk printing and printer failure recovery.

For the actual generated PDF QR check:

```sh
python -m pip install pymupdf Pillow zxing-cpp
LABEL_TEST_OUTPUT=/tmp/mawaid-labels npm test
python scripts/verify_labels.py /tmp/mawaid-labels
```

These use synthetic test guests. CI runs the same verification. A successful PDF decode does not establish real printer alignment, driver scaling, camera focus, lighting or local Wi-Fi performance; verify those using a physical sticker at the gate before admitting guests.
