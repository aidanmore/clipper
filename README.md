# Yellow Five clipper

A GitHub Pages cutting room for the live Yellow Five archive. No local server or running computer is needed.

## Use it

Open **https://aidanmore.github.io/clipper/**. Search by title or episode number, choose an episode, and start listening. **Last 30s** selects the moment you just heard. Mark start/end while listening, drag the zoomed waveform handles, nudge by 0.1 or 1 second, or enter a timestamp such as `12:34.50`.

Preview the selection, optionally loop it or hear two seconds of context, then save it to the clip tray. Saved clips can be edited, duplicated, removed with undo, and exported together. Clip drafts, reviewed suggestions, and listening position save in this browser. **Backup / Restore** moves saved clips between devices. **Copy link** shares one episode and exact selection.

Desktop shortcuts (outside controls): Space play/pause; arrows seek 5 seconds (Shift: 30); I/O mark start/end; P preview; S save. The waveform handles also support arrows (0.1 seconds; Shift: 1 second).

## Export from your phone

1. Choose **Export current selection** or **Export saved clips**.
2. Continue to GitHub, sign in as **aidanmore**, and submit the prefilled issue. Preserve its JSON block and title prefix.
3. Return to the clipper and tap **Check exports**. Downloads appear when the GitHub Actions job finishes. The issue also gets a direct download link.

Export produces variable-quality MP3s, preserving source channels. Multiple clips also get a ZIP. Up to 10 clips per request, 10 minutes per clip, 30 minutes total. Requests and release downloads are public. Only requests authored by the repository owner are processed. Keep the page open to see automatic checks every 90 seconds; requests can also be checked later or opened on GitHub. Release downloads remain available until removed from the repository.

The feed's audio host permits streaming but currently does not grant browser CORS access for audio processing. Repository-hosted Actions run FFmpeg so the phone can stream, edit, and request precise clips without downloading and decoding the entire episode. No credentials are embedded in the page.

## Waveforms and discovery

The page uses the live RSS feed, falling back to a generated catalog if the feed is unavailable. **Prepare clipper archive** runs every four hours and can be run manually from Actions. It refreshes the catalog and prepares four missing or changed episodes per run, newest first. Full audio is temporary on the runner; only compact amplitude and energy data is committed to `data/`. The page reads newly generated data from the repository, without waiting for a Pages rebuild.

Episodes work before their waveform is ready. Activity-based suggestions become available as analysis finishes. They rank audio energy, changes, and speech activity, settle boundaries near quiet sections, avoid overlap, and skip reviewed spots. They are listening leads, not AI judgments of humor. **Surprise me** is explicitly random. No full-episode speech model runs on the phone. The current feed does not publish transcripts.

## Your own audio

The archive's **Open your own audio** option plays local files. Files under 40 MB can be decoded for waveforms, suggestions, and stereo WAV export. Larger files remain playable and support saved selections; use the matching live archive episode for MP3 export. Local files stay on the device. Local-file links cannot reopen audio on another device; backups preserve clip timestamps.

## Development and checks

The site is buildless HTML/CSS/JavaScript. The runner scripts use Python's standard library, FFmpeg, and FFprobe. Workflows explicitly install FFmpeg. Run:

```sh
node --check app.js
node --test tests/core.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/prepare_archive.py --limit 4
```

`scripts/export_request.py` validates request limits, resolves the selected GUID from the fixed feed, verifies its source fingerprint, re-encodes accurate selections, verifies output durations, uploads MP3/ZIP assets to an unpublished draft release, then publishes it and closes the request. Request text is never executed as shell code. It uses the runner's short-lived `GITHUB_TOKEN`, scoped to contents and issues for this repository.

## Related tools

[Y5YT](https://aidanmore.github.io/clipper/y5yt/) prepares full episodes and upload metadata. Its existing [Windows FFmpeg launcher](y5yt/README.md) and [thumbnail editor](https://aidanmore.github.io/clipper/y5yt/thumbnail/) remain separate tools.
