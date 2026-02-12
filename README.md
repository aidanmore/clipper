# LaughSlice (GitHub-hostable, mobile-first)

A **fresh-start web app** for clipping comedy podcasts quickly on mobile or desktop.

## What it does now
- Drag/drop or tap-upload a long audio episode.
- Fast scan workflow (skip buttons, speed controls, waveform view).
- Set clip start/end intuitively with sliders or "set start/end = now".
- Preview a selected clip instantly.
- Export isolated clip as WAV locally.
- AI-style suggestion buttons:
  - **Suggest best clip**
  - **Suggest 5 fun clips**

> This version is intentionally static + client-side so it can be hosted directly on GitHub Pages.

## Host on GitHub Pages
1. Push repo to GitHub.
2. In repo settings, enable **Pages**.
3. Set source to main branch root.
4. Open your Pages URL.

No server required for this version.

## Notes
- Analysis is heuristic (energy + burst + density), designed for speed and practical clip discovery.
- Processing happens in-browser; no audio is uploaded to a backend in this version.
