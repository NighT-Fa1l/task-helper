# Task Helper — public deployment checklist

## Architecture

- Frontend: GitHub Pages
- Backend: Render (or any Node.js host)
- Database: PostgreSQL (Neon, Supabase, Render PostgreSQL, etc.)
- Login: Google Identity Services + backend ID-token verification

## 1. Google Cloud

Create one **OAuth client → Web application**.

Authorized JavaScript origins:

- `http://localhost:5173`
- `https://NighT-Fa1l.github.io`

Do not add `/task-organiser/` to the origin.

Enable **Google Calendar API** only if Calendar sync is used.

The Web client ID is public. Do not publish a Google client secret in the frontend.

## 2. PostgreSQL

Create a PostgreSQL database with your provider and copy its connection string.

The backend automatically creates its `users` and `tasks` tables at startup.

For managed PostgreSQL, set `DATABASE_SSL=true` if your provider requires it. Production mode also enables PostgreSQL TLS automatically.

## 3. Backend

Deploy the `server/` directory as a Node service.

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Health check:

```text
/api/health
```

Backend environment variables:

```text
DATABASE_URL=your-postgresql-connection-string
PORT=5000
FRONTEND_URL=https://NighT-Fa1l.github.io
JWT_SECRET=a-new-long-random-secret
GOOGLE_CLIENT_ID=your-google-web-client-id.apps.googleusercontent.com
NODE_ENV=production
COOKIE_SECURE=true
DATABASE_SSL=true
```

Do not use the example JWT secret in production.

## 4. Frontend GitHub variables

Repository → Settings → Secrets and variables → Actions → Variables.

Create:

```text
VITE_API_URL=https://YOUR-BACKEND-DOMAIN
VITE_GOOGLE_CLIENT_ID=YOUR_GOOGLE_WEB_CLIENT_ID.apps.googleusercontent.com
```

These are **Variables**, not Secrets. The Google client ID is intentionally sent to the browser.

## 5. GitHub Pages

Repository → Settings → Pages → Build and deployment → Source → **GitHub Actions**.

Leave Custom domain empty unless you actually own and configured a separate domain.

Push to `main`. The workflow builds `dist/` and deploys it to:

`https://NighT-Fa1l.github.io/task-organiser/`

## 6. Test

Open:

`https://YOUR-BACKEND-DOMAIN/api/health`

It should return JSON similar to:

```json
{"ok":true,"service":"task-helper-api"}
```

Then open the GitHub Pages site and sign in with Google.

## Important

GitHub Pages cannot run Node.js or PostgreSQL. The frontend and backend must therefore be deployed separately. The repository is intentionally structured that way.

## Google Drive storage

Task Helper v4 requests the Google Drive `drive.file` scope when the user uploads a persistent document. The binary file is stored in that user's Google Drive and the PostgreSQL database stores the Drive file ID and extracted PDF text. Make sure the Drive API is enabled for the same Google Cloud project used by the Web Client ID.
