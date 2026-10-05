# YT Translate

Paste a public YouTube link → get copy-ready English translations of the video's
**title**, **description**, and **thumbnail text**. Runs 100% in the browser —
there is no server.

Live: `https://kalyanreddyy.github.io/yt-metadata/`

## How it works

1. Paste any YouTube URL (`watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`).
2. Video metadata (title, description, channel, publish date, language) is fetched
   from the **YouTube Data API v3** directly in your browser.
3. The highest-resolution thumbnail is downloaded and read with **Tesseract.js**
   OCR (runs on-device; first use downloads ~15 MB of engine data).
4. Title, description, and thumbnail text are translated to English via the
   **Gemini API**.
5. Preservation checks run on every translation: line counts, URLs,
   numbers/timestamps.

## Setup (one time)

Open the page → **Key settings** and add:

- **YouTube Data API key** (required for metadata) — free at
  <https://console.cloud.google.com/apis/credentials> (enable "YouTube Data API v3").
- **Gemini API key** (required for translation) — free at
  <https://aistudio.google.com/apikey>.

Tick **Remember on this device** to store them in your browser's localStorage.
Keys never leave your browser except straight to Google's APIs.

## Deploy your own copy

This is a static site — any static host works:

```bash
# GitHub Pages: Settings → Pages → Deploy from a branch → main → /(root)
```

## Files

- `index.html` — page structure, styling, settings panel
- `app.js` — all logic (API calls, OCR, translation, checks, rendering)
