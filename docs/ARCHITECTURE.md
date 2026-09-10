# Task Helper architecture

## Product rule

Task Helper should feel like a quiet system rather than a chat app.

### Primary surfaces

- Today
- This week
- Tasks
- Helper
- Memory
- Progress
- Completed
- Settings

## Data ownership

Google Calendar remains an external source. Task Helper should cache only what it needs for indexing and display.

AI keys are user-owned. Do not ship a shared project API key.

## Google permissions

Start with:

`https://www.googleapis.com/auth/calendar.readonly`

Only request write access when a user explicitly enables Task Helper → Google Calendar task synchronization.

For birthdays, the Google Calendar API exposes birthday event types. A future sync worker can request those events separately and index their dates/titles.

## Memory

Future production implementation:

```text
metadata index
      ↓
document vault
      ↓
chunker → embeddings → vector index
      ↓
retrieval
      ↓
AI context
```

The UI should not dump the entire vault into every AI request. Retrieve only relevant chunks.

## Desktop

Use a Tauri shell around the web UI.

Native responsibilities:
- system tray
- startup
- native notifications
- global hotkey
- hide/quit behavior

Web responsibilities:
- dashboard
- tasks
- calendar
- memory
- AI interaction
