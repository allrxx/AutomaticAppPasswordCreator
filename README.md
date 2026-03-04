# Automatic App Password Creator

Web control panel to automate the full workflow on `mail.cazehiresense.com`:
1. Create mailboxes (Mailcow API)
2. Generate app passwords (webmail UI via Playwright)
3. Validate SMTP (and optional IMAP verification)

## Setup

### 1) Requirements
- Node.js 18+

### 2) Install dependencies
```powershell
cd web
npm install
```

### 3) Configure environment
```powershell
cd web
copy .env.example .env
```

Edit `web/.env`:
- Required:
  - `MAILCOW_API_KEY`
- Optional (enables IMAP verification if both are set):
  - `VALIDATION_RECEIVER_EMAIL`
  - `VALIDATION_RECEIVER_APP_PASSWORD`

If receiver values are empty, SMTP validation sends each test email to itself.

## Run

```powershell
cd web
npm start
```

Open: `http://localhost:3000`

## UI

User input is intentionally minimal:
- `Number of emails to create`

Everything else is server-configured from `web/.env`.

## Output

- Live execution logs in browser
- Per-mailbox results table
- Downloadable CSV in `web/output/<job-id>.csv`
