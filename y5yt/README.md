# Y5YT

Y5YT prepares full episodes of the main Yellow Five show for manual upload to YouTube. It reads the show's RSS feed for the original title, show notes, full audio, and individual cover art. Paste an Apple Podcasts episode link or search the archive by title or number.

## Open the page

The [GitHub Pages version](https://aidanmore.github.io/clipper/y5yt/) can browse the archive, copy the upload fields, and suggest tags from a pasted transcript on any device.

## Make an episode thumbnail

Open the [thumbnail editor](https://aidanmore.github.io/clipper/y5yt/thumbnail/) and choose an episode, or use **Make thumbnail** from an episode in Y5YT. Drag the preview or use the slider to position the 16:9 crop. The halftone print screen is on by default. **Fit on black** keeps the whole cover in view. **Save JPG** exports a 3840 × 2160 image under 2 MB.

## Render on Windows

1. Download the [clipper ZIP](https://github.com/aidanmore/clipper/archive/refs/heads/main.zip) and extract it. If you already have the repo locally, pull the latest changes.
2. Make sure Python 3.10 or newer is installed. The launcher looks for FFmpeg and FFprobe on PATH first, then for an extracted `ffmpeg*/bin/ffmpeg.exe` in your Downloads folder.
3. Double-click `start-y5yt.cmd` in the `y5yt` folder. Choose the episode and click **Render MP4** in the page it opens. Keep the launcher window open until processing finishes. You can close the browser tab and reopen [the local page](http://127.0.0.1:8755/y5yt/) to check progress.
4. Find the output in `Videos\Y5YT` or click **Download MP4**. Use the copy buttons for the title, description, and comma-separated tags.

If FFmpeg is somewhere else, open PowerShell in the extracted `y5yt` folder and run the launcher with the exact executable path.

```powershell
.\start-y5yt.cmd --ffmpeg "C:\path\to\ffmpeg\bin\ffmpeg.exe"
```

To choose an output folder, pass `--output "D:\Y5YT"`. The runner also works on macOS and Linux with FFmpeg and FFprobe on PATH and `python3 y5yt/server.py` from the repo root. The renderer is reachable from the computer running it.

## Reuse a transcript

Y5YT uses a transcript automatically when the episode’s RSS entry includes a supported transcript file. Spotify-hosted shows with this feature can turn it on under **Spotify for Creators → Settings → Transcripts → Distribute transcripts across other platforms via RSS**. This publishes the transcripts in the show’s public feed. [Spotify’s transcript settings](https://support.spotify.com/us/creators/article/managing-episode-transcripts-on-spotify/)

To use a file right away, select the episode in Y5YT, open **Use or review a transcript**, and choose **Import a transcript file**. You can use a VTT from Spotify for Creators or a transcript downloaded through Apple Podcasts Connect. Y5YT removes caption timing and suggests editable topic tags. [Spotify download instructions](https://support.spotify.com/us/creators/article/managing-episode-transcripts-on-spotify/) · [Apple download instructions](https://podcasters.apple.com/support/5316-transcripts-on-apple-podcasts)

## Generate tags from the episode audio with Whisper

Install faster-whisper once in PowerShell, using the same Python environment as the launcher.

```powershell
py -3 -m pip install faster-whisper==1.2.1
```

Use `python -m pip` if your installation uses `python` instead of `py`. Restart Y5YT and choose **Transcribe after rendering** or **Transcribe only**. The first use downloads Whisper's `small.en` model. Transcription runs on your CPU and can take time for a full episode. To use a different compatible local model, set `Y5YT_WHISPER_MODEL` to its folder or model name before launching.

Tag suggestions favor named phrases and topics that recur across the transcript. Review them for relevance and spelling before copying. The fields keep the original RSS title and description and remain editable. [YouTube's guidance](https://support.google.com/youtube/answer/146402) gives the title, thumbnail, and description more weight than tags.
