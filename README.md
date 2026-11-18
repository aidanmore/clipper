# Yellow Five clipper

A static, mobile-friendly cutting room at https://aidanmore.github.io/clipper/.

Choose an episode from the live archive, listen, and collect the good bits. **Last 30s** captures the moment you just heard. Drag the edges, mark start/end while listening, or enter fractional timestamps. Saved clips, listening position, reviewed suggestions, backups, and share links continue to work.

## Download clips

Choose **MP3** or **WAV**, then **Download current selection** or **Download saved clips**. The browser builds and downloads your audio directly. Batches include individual files and a ZIP. The download panel includes playback and Save buttons; supported phones also offer the native Share / Save to Files sheet. Keep the page open while encoding. Cancel is safe; drafts remain saved.

MP3 downloads are 192 kbps and retain stereo sources. WAV downloads contain the decoded source audio without another lossy encoding pass. Up to ten clips per batch, ten minutes each and thirty minutes total. There is no login, issue submission, export job, or export polling.

## How direct downloads work

The podcast host permits playback but does not send CORS headers, so browser capture alone cannot access its audio. `scripts/prepare_audio.py` automatically mirrors the original, unchanged MP3 bytes in 4 MiB objects on `clipper-audio-0` through `clipper-audio-3`. These branches are separate from the small Pages site. Each episode has a source fingerprint and a sparse, frame-aligned seek table. A scheduled workflow handles new episodes and retries failed preparation; the initial archive backfill runs in four independent jobs. A missing episode shows a preparation message and can be retried directly, with no user submission.

`direct-export.js` fetches only the objects touching the selection. It decodes twenty-second windows with MP3 preroll, then sends the selected samples to `encode-worker.js`. Encoding runs off the main thread. At most three compressed source objects stay cached. Exports and filenames remain on the device; they are not uploaded. Local files under 40 MB can also be decoded and exported directly.

Waveforms and activity-based suggestions use the existing analysis workflow. They are independent of download preparation and are not semantic joke detection. Y5YT and the thumbnail tool remain separate.

## Verification

`node --test tests/core.test.cjs` and `python -m unittest discover -s tests -p 'test_*.py'` check selections, analysis, and audio helpers. `tests/browser_export.py` runs the actual decoder/worker pipeline in Chromium and WebKit. It compares stereo WAV samples with native source decoding, checks fractional boundaries and cuts crossing source objects and twenty-second processing windows, verifies MP3 duration and stereo, and saves actual browser downloads. Run it with Playwright's Chromium and WebKit browsers installed. The verification workflow installs these dependencies.

Vendored browser dependencies: [lamejs 1.2.1](https://github.com/zhuker/lamejs), a JavaScript port of [LAME](https://lame.sourceforge.net/) (LGPL-3.0), and [fflate 0.8.2](https://github.com/101arrowz/fflate) (MIT); their licenses are in `vendor/`.

For a lightweight source checkout, use `git clone --single-branch --depth 1 https://github.com/aidanmore/clipper.git`. The audio branches intentionally hold the larger source archive.
