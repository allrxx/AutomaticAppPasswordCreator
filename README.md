# App Password Generator for Cazehiresense

Automates app password creation for mailboxes on `mail.cazehiresense.com`.

---

## Web Control Panel (Create -> App Password -> Validate)

Use the new UI when you want one workflow that:
1. Creates mailboxes from Mailcow API
2. Generates app passwords in webmail with Playwright
3. Sends SMTP test emails and verifies via IMAP

### Run

```powershell
cd web
npm install
npm start
```

Open: `http://localhost:3000`

### Setup Environment (required once)

```powershell
cd web
copy .env.example .env
```

Edit `.env` and set sensitive values:
- `MAILCOW_API_KEY`
- `VALIDATION_RECEIVER_EMAIL` (optional)
- `VALIDATION_RECEIVER_APP_PASSWORD` (optional)

Everything else is preconfigured to your existing script defaults (`mail.cazehiresense.com`, `cazehiresense.com`, app name `hiresense`).

If receiver values are empty, SMTP validation auto-sends to each mailbox itself.
If receiver values are provided, IMAP inbox verification is enabled.

### UI Input

The user only enters:
- `Number of emails to create`

### Output

- Live progress and logs in the browser
- Per-mailbox result table (email, password, app password, status)
- Downloadable CSV: `web/output/<job-id>.csv`

---

## Installation (First Time Setup)

1. **Install Node.js** (v18 or higher) from [nodejs.org](https://nodejs.org)

2. **Install dependencies:**
   ```powershell
   cd automation
   npm install playwright csv-parse csv-stringify
   ```

3. **Install browser:**
   ```powershell
   npx playwright install chromium
   ```

---

## Quick Start

1. **Replace `emails.csv`** with your data (keep the same column format). JUST EXPORT THE GOOGLE SHEET AS CSV FILE
2. **Run the script:**
   ```powershell
   cd automation
   node ProcessAllCandidates.js
   ```
3. **Results saved to:** `emails-results.csv`

---

## CSV Format

| Column | Description |
|--------|-------------|
| `email` | Mailbox email address |
| `password` | Mailbox login password |
| `name` | User display name |
| `quota` | Mailbox quota (can be 0) |
| `app_password` | Leave empty - will be filled by script |
| `assignee` | Person responsible |

**Note:** Supports both comma (`,`) and tab-separated files.

---

## Features

- ✅ **Auto-skip** - Skips rows that already have an app password value
- ✅ **Resume support** - Saves progress after each user; re-run to continue if interrupted
- ✅ **IMAP + SMTP only** - Disables POP3, Sieve, EAS, CardDAV protocols
- ✅ **Auto-detect delimiter** - Works with both comma and tab-separated CSV files
- ✅ **Fresh session per user** - Uses new browser context for each login (no logout issues)
- ✅ **Server-side check** - Also checks if "hiresense" password already exists on the mail server

---

## Files

| File | Description |
|------|-------------|
| `ProcessAllCandidates.js` | Main script - processes all users in CSV |
| `TestForSingleUser.js` | Debug script - opens visible browser for single user |
| `emails.csv` | Input file - your mailbox data |
| `emails-results.csv` | Output file - results with generated passwords |

---

## Troubleshooting

**Script stuck or crashed?**  
Just re-run it - progress is saved and it will resume from where it left off.

**Need to debug a single user?**  
Edit credentials in `TestForSingleUser.js` and run it - opens a visible browser window.

**Login fails for a user?**  
Check if the password in CSV is correct. The error will be logged in console.

---

*Last updated: January 29, 2026*
