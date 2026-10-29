# Clipper / Yellow Five

A personal podcast editing desk. Pick a published episode, find promising exchanges, audition and trim them, then export stereo audio and captions. The static interface can stay at `aidanmore.github.io/clipper`; the processing service runs separately. It can also serve the interface itself.

## What ships in v2

- Preconfigured Yellow Five RSS library, direct HTTPS audio import, and streamed recording uploads.
- One immutable audio snapshot per project, with SHA-256 identity. Transcription, playback, and export use that snapshot.
- AssemblyAI word timestamps and speaker labels; language-model selection of actual word ranges, overlapping transcript windows, editorial explanations, short/full variants, topic markers, and deduplication.
- Literal transcript search and descriptive moment search. Existing keeps/skips become examples for subsequent requests; this is prompt-based personalization, not model training.
- Click-to-listen transcript; passage selection; speaker renaming; word corrections that preserve timing.
- Overview and detailed waveforms, draggable edges, exact time fields, 0.1-second nudges, sentence extension, loop, boundary preview, playback speeds, and shortcuts.
- Saved shortlist, names, notes, alternate cuts, ready/exported states, autosave, undo/redo, playback position, optimistic concurrency, and project JSON backups/restoration against matching audio.
- Background import/transcription/analysis/export jobs persisted in SQLite. Closing the browser does not cancel server work.
- MP3 (192 kbps), WAV (16-bit), SRT, TXT, and MP3/captions/text bundles. Multiple files arrive in a ZIP. Source channels are preserved. Optional tiny boundary fades and loudness adjustment.
- Private password access, scoped expiring playback/download links, configurable usage/storage limits, and no browser-side provider credentials.
- A clearly labeled editor tour with sample text and a quiet test tone. It makes no API calls.
- Original static clipper preserved at `/legacy/` for use without the processing service.

The first release proposes moments from the **transcript**. It does not detect laughter or judge vocal delivery. Audition suggestions before using them. No generated speech, rewritten audio, or automatic filler removal is applied.

## Run locally

Requires Node 24+, FFmpeg and FFprobe on PATH. On Debian/Ubuntu: `sudo apt-get install ffmpeg`.

```sh
npm ci
cp .env.example .env
openssl rand -hex 32
```

Set `CLIPPER_PASSWORD` to a unique password of at least 16 characters and `SESSION_SECRET` to a random value of at least 32 characters. Paste the generated secret into `.env`. Add `ASSEMBLYAI_API_KEY` to enable AI; without it, imports, manual editing, persistence and exports still work.

```sh
npm start
```

Open `http://localhost:3000`, connect to that workspace URL, and enter your workspace password. Provider keys belong only in the server environment. Never put them in GitHub Pages, `app.js`, or a committed `.env`.

## Deploy the processing service

1. In Railway, create a project from this GitHub repository and select the branch containing v2. The included Dockerfile installs Node and FFmpeg; `railway.json` sets the health check.
2. Attach a **persistent volume at `/data`**. This is required: without it, redeploying loses imported recordings and projects. Run **one replica**; SQLite and the worker are designed for one service instance.
3. In service variables set `DATA_DIR=/data`, `CLIPPER_PASSWORD`, `SESSION_SECRET`, and `ASSEMBLYAI_API_KEY`. Generate the secrets privately. The container sets `TRUST_PROXY=1` for Railway's proxy; set it to `0` if exposing the service directly.
4. Set `ALLOWED_ORIGINS=https://aidanmore.github.io` for the existing Pages interface. Add other exact frontend origins separated by commas. The service's own origin is allowed too.
5. Generate a public HTTPS domain in Railway. Open `/health` to confirm it starts. Open the service domain to use the editor directly.
6. In the GitHub Pages editor, open **workspace settings**, enter that HTTPS domain and your Clipper password. The URL is remembered locally; the session is kept in that browser tab/session. Cross-device access uses the same private workspace.
7. Start with one episode. Import first; choose **find moments** when ready to use the provider. Validate transcript quality and suggested cuts before processing a backlog.

The repository can contain the interface and backend source publicly. Recordings, SQLite, secrets, generated files, and test output are excluded from git and the Docker build. The backend serves an explicit allowlist of frontend files, never the data directory or environment files.

### Configuration

| Variable              | Default                        | Meaning                                                                                           |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `PORT`                | `3000`                         | Listening port; Railway sets this automatically.                                                  |
| `DATA_DIR`            | `./data`                       | Durable database, audio and exports. Mount `/data` in deployment.                                 |
| `CLIPPER_PASSWORD`    | required                       | Workspace password, 16+ characters.                                                               |
| `SESSION_SECRET`      | required                       | Random signing secret, 32+ characters. Rotating it expires existing sessions/links.               |
| `ASSEMBLYAI_API_KEY`  | empty                          | Server-side provider key. Manual work functions without it.                                       |
| `PODCAST_FEED_URL`    | Yellow Five feed               | `https://anchor.fm/s/1014cea94/podcast/rss`                                                       |
| `ALLOWED_ORIGINS`     | `https://aidanmore.github.io`  | Exact permitted browser origins, comma-separated.                                                 |
| `TRUST_PROXY`         | `0` locally / `1` in container | Trust one reverse proxy; use only behind a trusted platform proxy.                                |
| `SPEECH_MODEL`        | `universal-3-5-pro`            | AssemblyAI async transcription model.                                                             |
| `LLM_MODEL`           | `gemini-2.5-flash`             | Model ID offered by AssemblyAI LLM Gateway. Change this to compare models on the same transcript. |
| `MAX_FILE_MB`         | `600`                          | Per-import/upload byte limit.                                                                     |
| `MAX_EPISODE_HOURS`   | `4`                            | Maximum accepted duration.                                                                        |
| `MAX_STORAGE_GB`      | `4`                            | App storage budget; leave room on the actual volume.                                              |
| `MONTHLY_AUDIO_HOURS` | `10`                           | Maximum reserved transcription hours per UTC calendar month.                                      |
| `MONTHLY_LLM_CALLS`   | `200`                          | Maximum submitted gateway requests per UTC calendar month.                                        |

Limits are application safeguards, **not a provider dollar-billing cap**. Add provider/platform spending limits too. Transcription allowance is reserved before submission and is not refunded automatically after failure. Explicitly resubmitting an uncertain/failed transcription reserves another allowance. Gateway calls and returned token counts are recorded, including requests that fail after submission. Model rates and gateway availability can change; consult the provider's current pricing. No paid request runs just from opening the site.

### Processing, recovery, and storage

- Published episodes are fetched server-to-server, so they do not need downloading/uploading through your phone. Unreleased uploads must finish before closing their upload tab.
- Feed entries deduplicate by feed/GUID; audio-link imports deduplicate by source URL. Each project downloads one source snapshot and retains it. A re-import with a different identity is a separate project and can incur another transcription.
- Every job and completed analysis window is checkpointed. Submitted transcription IDs survive restarts; polling resumes without resubmitting audio. Imports and exports can safely restart. An interrupted language-model submission is surfaced for explicit retry rather than silently billed again.
- If the provider received a transcription but the response was lost, use **project options → recover a provider transcript**, with its ID from the AssemblyAI dashboard. Explicit Retry can submit again and may incur a duplicate charge. Never recover an ID from a different recording: its words will not match this audio.
- AI tasks are serialized on one worker. Provider polling releases the worker between checks. A large analysis/export can delay another task.
- You can cancel future processing steps from the progress bar. A running step finishes before cancellation takes effect; AI already submitted can still be billed.
- Job progress shows real stages and window counts, not an invented time estimate. There is no guaranteed processing latency until the actual hosted service and provider are measured.
- Original audio is retained until you delete its project. **Clear old export files** reclaims generated downloads while retaining source/transcript/edits. **Delete project** removes its source and exports permanently after jobs finish. No automatic source deletion is performed.
- Project backup JSON includes transcript and edits, **not audio**. Keep original recordings separately. To restore, import the same original file, wait for its waveform, then restore the backup. The hash must match. For full disaster recovery, back up the persistent volume/database and media together using the host's volume backup facilities.
- Autosave uses edit revision checks. A conflicting device is prevented from overwriting your changes. Download a backup of unsaved local edits and reload the project to reconcile. Undo history is per open editing session; saved edits persist across sessions.
- Playback links last 12 hours; download links last 15 minutes. Reopen a project to renew playback, or reopen Export to obtain new download links. Links confer temporary access; avoid sharing them unintentionally.
- The server needs outbound HTTPS and public DNS for RSS, audio hosts, and AssemblyAI. Imports reject private/reserved destinations, unsafe schemes, credentials, unusual ports, and redirects into private networks; DNS is checked at connection time. FFmpeg input is restricted to supported file formats and local protocols.

## Checks

```sh
npm run check
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

The integration suite generates real stereo fixtures and runs actual FFmpeg imports/exports. Provider calls use a deterministic fake: passing tests does **not** demonstrate real transcription accuracy, humor selection, model availability, provider pricing, or hosted performance. The browser suite exercises the editor, saved projects, exports, and a narrow phone viewport. A viewport check is not a physical iPhone/Safari test.

For a WebKit pass after installing that browser:

```sh
npx playwright install --with-deps webkit
BROWSER_ENGINE=webkit npm run test:browser
```

Before a production rollout, process one real Yellow Five episode with the configured provider, inspect timing/crosstalk, compare the first ten suggestions against the target of three genuinely usable candidates, and measure elapsed time and actual costs. This evaluation requires the live provider key and editorial judgment. Keep the existing deployment until the new workspace is configured and verified.

Captioned video, cross-episode semantic search, automatic new-episode processing, and audio-aware laughter/delivery analysis are subsequent features; they are not included in this audio-focused release.
