# GitHub Pages deployment

This repository is a Vite PWA frontend plus a separate Node/Express API in `server/`.

## GitHub Pages

Use **Settings → Pages → Source → GitHub Actions**.

The repository URL is expected to be:
`https://NighT-Fa1l.github.io/task-organiser/`

Do **not** put that URL in Custom domain. Leave Custom domain empty unless you own a separate domain and have configured its DNS.

Create these repository variables under **Settings → Secrets and variables → Actions → Variables**:

- `VITE_API_URL` = your deployed backend URL, e.g. `https://task-helper-api.example.com`
- `VITE_GOOGLE_CLIENT_ID` = your Google Web OAuth client ID

These are frontend build variables, not secrets. Never put a Google client secret, database password, or JWT secret in them.

## Backend

Deploy `server/` to a Node host such as Render. Set its environment variables from `server/.env.example`.

The backend needs a PostgreSQL database. Run `server/schema.sql` once against that database.

## Google OAuth

This implementation uses Google Identity Services ID-token login. It does not need a Google client secret for login.

In Google Cloud, configure the Web OAuth client with these **Authorized JavaScript origins**:

- `http://localhost:5173`
- `https://NighT-Fa1l.github.io`

The GitHub Pages origin is the origin only; do not add `/task-organiser/` to the origin field.

Enable the Google Calendar API only if Calendar sync is wanted.
