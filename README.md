# Task Helper v4

Task Helper is an AI-first study workspace built as a real multi-user web app: PostgreSQL is the structured source of truth, Google Drive stores the user's actual PDF/image files, and the AI can operate the workspace instead of only chatting.

## v4 UI

- Fixed-height three-column workspace so the whole page does not keep growing vertically.
- Larger, more readable typography and denser side panels.
- Right side starts with a real calendar panel.
- Calendar event dates are full colored circles instead of tiny dots.
- Time tools are one compact switcher: **Clock → Stopwatch → Timer**, using left/right arrows.
- Center remains the main AI workspace and can switch into document mode.

## Persistent data

When signed in, PostgreSQL stores:

- tasks
- classes
- notes
- goals
- calendar events and their colors
- document metadata, Drive file IDs and extracted PDF text

The actual uploaded PDF/image binary is stored in the user's Google Drive. Task Helper keeps the Drive file ID in PostgreSQL so the workspace can pull the same file back later.

## AI workspace control

The server-side AI receives the user's current workspace context and can return structured actions for:

- creating/updating/completing tasks
- creating/updating classes
- creating/updating notes
- creating/updating goals
- creating/updating calendar events and colors
- opening Tasks, Classes, Notes, Goals, Calendar or Documents
- analyzing attached PDFs and images

Example requests:

- “Move my physics task to tomorrow at 6 PM.”
- “Make a new blue calendar event for my CS50 quiz Friday at 8 PM.”
- “Turn this PDF into three tasks and a note.”
- “Rename my physics class.”

## Google Drive

The browser uses Google Identity Services to request the `drive.file` permission when a user first needs Drive storage. The backend uses that user OAuth access token to upload and download files, while PostgreSQL stores the metadata and Drive file ID.

For production, configure the Google OAuth consent screen and the required Drive API access in Google Cloud. Google notes that scopes accessing user data can require verification depending on the scope and app configuration.

## AI environment

Set these on the backend host:

```env
AI_API_KEY=...
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
```

The production AI key stays on the server.

## Local development

Frontend:

```bash
npm install
npm run dev
```

Backend:

```bash
cd server
npm install
npm run dev
```

Copy `server/.env.example` to `server/.env` and provide PostgreSQL, JWT, Google Client ID and AI settings.

## Google login

Use the same Google Web Client ID in:

```env
VITE_GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_ID=...
```

For GitHub Pages, authorize the site origin such as `https://NighT-Fa1l.github.io` rather than the repository path.

## Security

Do not put the AI API key in frontend source. Also replace any JWT secret that has ever been exposed before deploying publicly.
