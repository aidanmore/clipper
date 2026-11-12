"""Loopback-only Y5YT companion. Run with Python 3.10 or newer."""

import argparse
from functools import partial
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from threading import Lock, Thread
from time import monotonic
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
import webbrowser
import xml.etree.ElementTree as ET

from censor import RATE, SLOT_IDS, apply_edits, edits_from_request, get_sounds


FEED = "https://anchor.fm/s/1014cea94/podcast/rss"
ITUNES = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
TRANSCRIPT_LIMIT = 5 * 1024 * 1024
COVER_LIMIT = 32 * 1024 * 1024
AUDIO_LIMIT = 1024**3
SOUND_LIMIT = 8 * 1024 * 1024
PAGE = Path(__file__).resolve().parent
STATIC = {"/y5yt/": "index.html", "/y5yt/index.html": "index.html",
          "/y5yt/style.css": "style.css", "/y5yt/app.js": "app.js",
          "/y5yt/censor.js": "censor.js",
          "/y5yt/topics.js": "topics.js", "/pcrp.ico": "../pcrp.ico",
          "/y5yt/thumbnail/": "thumbnail/index.html",
          "/y5yt/thumbnail/index.html": "thumbnail/index.html",
          "/y5yt/thumbnail/app.js": "thumbnail/app.js",
          "/y5yt/thumbnail/thumbnail.css": "thumbnail/thumbnail.css"}
STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".js": "text/javascript; charset=utf-8", ".ico": "image/x-icon"}
SQUARE = ("scale=1080:1080:force_original_aspect_ratio=decrease,"
          "pad=1080:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p")
feed_lock = Lock()
cached_feed = (0, b"")


def find_tools(explicit):
    executable = explicit or shutil.which("ffmpeg")
    if not executable and os.name == "nt":
        candidates = (Path.home() / "Downloads").glob("ffmpeg*/bin/ffmpeg.exe")
        executable = max(candidates, key=lambda path: path.stat().st_mtime, default=None)
    if not executable:
        return None, None
    ffmpeg = Path(executable).expanduser().resolve()
    sibling = ffmpeg.with_name("ffprobe" + ffmpeg.suffix)
    ffprobe = sibling if sibling.is_file() else shutil.which("ffprobe")
    return (str(ffmpeg), str(ffprobe)) if ffmpeg.is_file() and ffprobe else (None, None)


def open_source(url, timeout=30):
    if urlsplit(url).scheme != "https":
        raise ValueError("The podcast source must use HTTPS.")
    return urlopen(Request(url, headers={"User-Agent": "Y5YT/1.0"}), timeout=timeout)


def feed_xml():
    global cached_feed
    with feed_lock:
        expires, body = cached_feed
        if monotonic() >= expires:
            with open_source(FEED) as response:
                body = response.read(4 * 1024 * 1024)
            cached_feed = (monotonic() + 60, body)
        return body


def episode_guid(guid):
    if not isinstance(guid, str) or not re.fullmatch(r"[\w.-]{1,128}", guid):
        raise ValueError("Invalid episode identifier.")
    return guid


def episode_by_guid(guid):
    channel = ET.fromstring(feed_xml()).find("channel")
    for item in channel.findall("item"):
        if item.findtext("guid") != guid:
            continue
        audio = item.find("enclosure")
        cover = item.find(ITUNES + "image")
        return {
            "title": item.findtext("title") or "yellow five",
            "number": item.findtext(ITUNES + "episode") or "",
            "audio": audio.get("url", "") if audio is not None else "",
            "cover": cover.get("href", "") if cover is not None else "",
            "transcripts": [(child.get("url") or "").strip() for child in item
                            if child.tag.rsplit("}", 1)[-1] == "transcript"],
        }
    raise ValueError("This episode is no longer in the Yellow Five feed. Refresh the archive and try again.")


def download(url, target, byte_limit, update):
    with open_source(url) as response, target.open("wb") as output:
        total = int(response.headers.get("Content-Length") or 0)
        if response.status != 200 or total > byte_limit:
            raise ValueError("The podcast host returned an unexpected media response.")
        size = 0
        while chunk := response.read(256 * 1024):
            size += len(chunk)
            if size > byte_limit:
                raise ValueError("The media exceeds the local download limit.")
            output.write(chunk)
            update(size / total if total else None)
        if not size or (total and size != total):
            raise ValueError("The media download was incomplete. Try again.")


def ffmpeg_run(executable, args, error_log, report=None):
    command = [executable, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
               "-progress", "pipe:1", *map(str, args)]
    with error_log.open("w+", encoding="utf-8", errors="replace") as errors:
        with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True,
                              encoding="utf-8", errors="replace") as process:
            for line in process.stdout:
                if report and line.startswith("out_time_us="):
                    value = line.partition("=")[2].strip()
                    if value.lstrip("-").isdigit():
                        report(int(value) / 1_000_000)
            if process.wait():
                errors.seek(0)
                details = errors.read().strip().splitlines()
                raise RuntimeError(details[-1] if details else "FFmpeg could not finish the export.")


def audio_info(ffprobe, path):
    result = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=duration,channels:format=duration", "-of", "json", str(path)],
        capture_output=True, check=True, text=True, timeout=30,
    )
    data = json.loads(result.stdout)
    if not data.get("streams"):
        raise ValueError("FFprobe found no audio stream.")
    stream = data["streams"][0]
    duration = stream.get("duration")
    return float(duration if duration not in (None, "N/A") else data["format"]["duration"]), stream["channels"]


def audio_duration(ffprobe, path):
    return audio_info(ffprobe, path)[0]


def decode_pcm(ffmpeg, source, output, log, window=None, report=None):
    filters = f"aresample={RATE}"
    if window:
        start, end = window
        # Trim after decoding and resampling so preview and render share sample boundaries.
        first, last = (time * (RATE // 1000) for time in (start, end))
        filters += f",atrim=start_sample={first}:end_sample={last},asetpts=PTS-STARTPTS"
    ffmpeg_run(ffmpeg, ["-i", source, "-map", "0:a:0", "-af", filters, "-f", "f32le", output], log, report)


def pcm_input(path, channels):
    return ["-f", "f32le", "-ar", str(RATE), "-ac", str(channels), "-i", path]


def render(ffmpeg, ffprobe, audio, cover, work, destination, update, edits=(), sounds=None):
    log = work / "ffmpeg.log"
    source_duration, channels = audio_info(ffprobe, audio)
    audio_input = ["-i", audio]
    stage = "Encoding the original episode audio"
    if edits:
        pcm = work / "episode.pcm"
        update("Preparing audio for censor edits", 0)
        decode_pcm(ffmpeg, audio, pcm, log, report=lambda time:
                   update("Preparing audio for censor edits", time / source_duration))
        apply_edits(pcm, channels, edits, sounds)
        audio_input = pcm_input(pcm, channels)
        stage = "Encoding the censored episode audio"
    update(stage, 0)
    encoded_audio = work / "episode.m4a"
    ffmpeg_run(ffmpeg, [*audio_input, "-map", "0:a:0", "-map_metadata", "-1",
                        "-c:a", "aac", "-b:a", "256k", "-ar", "48000", encoded_audio],
               log, lambda time: update(stage, time / source_duration))
    duration = audio_duration(ffprobe, encoded_audio)

    update("Preparing the 1080 × 1080 cover", None)
    frame = work / "frame.png"
    loop = work / "cover.mp4"
    ffmpeg_run(ffmpeg, ["-i", cover, "-frames:v", "1", "-vf", SQUARE, "-update", "1", frame], log)
    ffmpeg_run(ffmpeg, ["-loop", "1", "-framerate", "24", "-i", frame, "-t", "12",
                        "-an", "-c:v", "libx264", "-tune", "stillimage", "-preset", "fast",
                        "-crf", "21", "-g", "288", "-pix_fmt", "yuv420p", loop], log)

    update("Writing the full-length MP4", 0)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".mp4", delete=False) as file:
        partial_video = Path(file.name)
    try:
        ffmpeg_run(ffmpeg, ["-stream_loop", "-1", "-i", loop, "-i", encoded_audio,
                            "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
                            "-t", f"{duration:.6f}", "-movflags", "+faststart", partial_video],
                   log, lambda time: update("Writing the full-length MP4", time / duration))
        if abs(audio_duration(ffprobe, partial_video) - duration) > 0.15:
            raise RuntimeError("The export did not contain the complete audio track.")
        partial_video.replace(destination)
    finally:
        partial_video.unlink(missing_ok=True)


def transcribe(ffmpeg, audio, work, update):
    from faster_whisper import WhisperModel
    import numpy as np

    update("Preparing the audio for transcription", None)
    pcm = work / "speech.pcm"
    ffmpeg_run(ffmpeg, ["-i", audio, "-map", "0:a:0", "-ac", "1", "-ar", "16000",
                        "-f", "f32le", pcm], work / "ffmpeg.log")
    samples = np.fromfile(pcm, dtype="<f4")
    update("Loading the local Whisper model (first run downloads it)", None)
    model = WhisperModel(os.environ.get("Y5YT_WHISPER_MODEL", "small.en"),
                         device="cpu", compute_type="int8", cpu_threads=min(os.cpu_count() or 2, 8))
    segments, info = model.transcribe(samples, language="en", beam_size=3, vad_filter=True,
                                      condition_on_previous_text=False)
    update("Transcribing locally for topic tags", 0)
    lines = []
    for segment in segments:
        if segment.text.strip():
            lines.append(segment.text.strip())
        update("Transcribing locally for topic tags", segment.end / max(info.duration, 1))
    if not lines:
        raise ValueError("Whisper did not find speech in this episode.")
    return "\n".join(lines)


class Companion:
    def __init__(self, ffmpeg, ffprobe, output, cache):
        self.ffmpeg, self.ffprobe = ffmpeg, ffprobe
        self.output = output
        self.cache = cache
        self.sound_directory = output / ".censor-sounds"
        self.audio_lock = Lock()
        self.whisper = importlib.util.find_spec("faster_whisper") is not None
        self.lock = Lock()
        self.job = None
        self.video = None

    def snapshot(self):
        with self.lock:
            return dict(self.job) if self.job else None

    def update(self, **fields):
        with self.lock:
            self.job.update(fields)

    def cached_audio(self, url, update=lambda _: None):
        if not url:
            raise ValueError("This episode has no audio in the feed.")
        key = sha256(url.encode()).hexdigest()
        audio = self.cache / (key + ".mp3")
        with self.audio_lock:
            if not audio.is_file():
                partial_audio = audio.with_suffix(".part")
                try:
                    download(url, partial_audio, AUDIO_LIMIT, update)
                    partial_audio.replace(audio)
                finally:
                    partial_audio.unlink(missing_ok=True)
        return audio

    def save_sound(self, slot, body):
        self.sound_directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=self.sound_directory) as temp:
            work = Path(temp)
            source, sound = work / "source", work / "sound.pcm"
            source.write_bytes(body)
            ffmpeg_run(self.ffmpeg, ["-protocol_whitelist", "file", "-format_whitelist",
                                    "aac,aiff,flac,matroska,webm,mov,mp3,ogg,wav", "-i", source,
                                    "-map", "0:a:0", "-t", "5", "-ac", "1", "-ar", str(RATE),
                                    "-f", "f32le", sound], work / "ffmpeg.log")
            if not sound.stat().st_size:
                raise ValueError("That file does not contain playable audio.")
            sound.replace(self.sound_directory / (slot + ".pcm"))

    def preview(self, guid, window, edits):
        sounds = get_sounds(edits, self.sound_directory)
        audio = self.cached_audio(episode_by_guid(guid)["audio"])
        duration, channels = audio_info(self.ffprobe, audio)
        if window[0] >= duration * 1000:
            raise ValueError("That timestamp is past the end of the episode.")
        with tempfile.TemporaryDirectory(prefix="y5yt-preview-") as temp:
            work = Path(temp)
            pcm, wav, log = work / "clip.pcm", work / "clip.wav", work / "ffmpeg.log"
            decode_pcm(self.ffmpeg, audio, pcm, log, window)
            apply_edits(pcm, channels, edits, sounds, offset=window[0])
            ffmpeg_run(self.ffmpeg, [*pcm_input(pcm, channels), "-c:a", "pcm_s16le", wav], log)
            return wav.read_bytes()

    def start(self, guid, action, edits):
        if not self.ffmpeg:
            raise ValueError("FFmpeg and FFprobe were not found. Restart with --ffmpeg pointing to ffmpeg.exe.")
        if action in {"transcribe", "both"} and not self.whisper:
            raise ValueError("Install faster-whisper, then restart Y5YT to transcribe automatically.")
        sounds = get_sounds(edits, self.sound_directory)
        with self.lock:
            if self.job and self.job["state"] == "running":
                raise ValueError("An episode is already being processed.")
            previous = self.job if self.job and self.job["guid"] == guid else {}
            if not previous or action != "transcribe":
                self.video = None
            self.job = {"guid": guid, "state": "running", "stage": "Reading the episode feed",
                        "progress": None, "video": previous.get("video") if action == "transcribe" else None,
                        "video_edits": previous.get("video_edits") if action == "transcribe" else None,
                        "transcript": previous.get("transcript"), "error": None}
            initial = dict(self.job)
            Thread(target=self.process, args=(guid, action, edits, sounds), daemon=True).start()
            return initial

    def process(self, guid, action, edits, sounds):
        def progress(stage, percent=None):
            self.update(stage=stage, progress=None if percent is None else min(1, max(0, percent)))

        try:
            episode = episode_by_guid(guid)
            with tempfile.TemporaryDirectory(prefix="y5yt-") as temp:
                work = Path(temp)
                cover = work / "cover.image"
                progress("Downloading the full episode audio")
                audio = self.cached_audio(episode["audio"], partial(progress, "Downloading the full episode audio"))
                if action in {"render", "both"}:
                    if not episode["cover"]:
                        raise ValueError("This episode has no individual cover in the feed.")
                    progress("Downloading the episode cover")
                    download(episode["cover"], cover, COVER_LIMIT,
                             partial(progress, "Downloading the episode cover"))
                    slug = re.sub(r"[^a-z0-9]+", "-", episode["title"].lower()).strip("-")[:64]
                    number = re.sub(r"\D", "", episode["number"])
                    name = "-".join(filter(None, ("yellow-five", number, slug, "censored" if edits else ""))) + ".mp4"
                    destination = self.output / name
                    render(self.ffmpeg, self.ffprobe, audio, cover, work, destination, progress, edits, sounds)
                    with self.lock:
                        self.video = destination
                        self.job["video"] = name
                        self.job["video_edits"] = edits
                if action in {"transcribe", "both"}:
                    self.update(transcript=transcribe(self.ffmpeg, audio, work, progress))
            self.update(state="done", stage="Ready", progress=1)
        except Exception as error:
            self.update(state="error", stage="Stopped", progress=None, error=str(error))


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, companion, **kwargs):
        self.companion = companion
        super().__init__(*args, **kwargs)

    def valid_host(self):
        expected = f"127.0.0.1:{self.server.server_port}"
        if self.headers.get("Host") == expected:
            return True
        self.send_error(403)
        return False

    def send_bytes(self, body, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, data, status=200):
        self.send_bytes(json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8", status)

    def do_GET(self):
        if not self.valid_host():
            return
        path = urlsplit(self.path)
        if path.path == "/":
            self.send_response(302)
            self.send_header("Location", "/y5yt/")
            self.end_headers()
        elif path.path in STATIC:
            file = PAGE / STATIC[path.path]
            self.send_bytes(file.read_bytes(), STATIC_TYPES[file.suffix])
        elif path.path == "/api/status":
            self.send_json({"ffmpeg": bool(self.companion.ffmpeg), "whisper": self.companion.whisper,
                            "output": str(self.companion.output), "job": self.companion.snapshot(),
                            "sounds": [slot for slot in SLOT_IDS if
                                       (self.companion.sound_directory / (slot + ".pcm")).is_file()]})
        elif path.path == "/api/feed":
            try:
                self.send_bytes(feed_xml(), "application/rss+xml; charset=utf-8")
            except (OSError, ValueError) as error:
                self.send_json({"error": str(error)}, 502)
        elif path.path == "/api/video":
            self.send_video(parse_qs(path.query).get("guid", [""])[0])
        elif path.path == "/api/audio":
            self.send_audio(parse_qs(path.query).get("guid", [""])[0])
        elif path.path == "/api/cover":
            self.send_cover(parse_qs(path.query).get("guid", [""])[0])
        elif path.path == "/api/transcript":
            params = parse_qs(path.query)
            self.send_transcript(params.get("guid", [""])[0], params.get("url", [""])[0])
        else:
            self.send_error(404)

    def send_audio(self, guid):
        try:
            audio = self.companion.cached_audio(episode_by_guid(episode_guid(guid))["audio"])
        except (ValueError, OSError, ET.ParseError) as error:
            self.send_json({"error": str(error)}, 502)
            return
        with audio.open("rb") as file:
            size = os.fstat(file.fileno()).st_size
            start, end = 0, size - 1
            requested = self.headers.get("Range")
            if requested:
                match = re.fullmatch(r"bytes=(\d{0,12})-(\d{0,12})", requested)
                if match and match[1]:
                    start = int(match[1])
                    end = min(end, int(match[2])) if match[2] else end
                elif match and match[2]:
                    start = max(0, size - int(match[2]))
                else:
                    start = size
                if start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
            self.send_response(206 if requested else 200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Cache-Control", "no-store")
            if requested:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            file.seek(start)
            try:
                while start <= end:
                    chunk = file.read(min(256 * 1024, end - start + 1))
                    self.wfile.write(chunk)
                    start += len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def send_cover(self, guid):
        try:
            url = episode_by_guid(guid)["cover"]
            if not url:
                self.send_json({"error": "The episode has no cover art."}, 404)
                return
            with open_source(url) as response:
                content_type = response.headers.get_content_type()
                if content_type not in {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/avif", "image/gif"}:
                    raise ValueError("The podcast host did not return a supported image.")
                cover = response.read(COVER_LIMIT + 1)
            if len(cover) > COVER_LIMIT:
                self.send_json({"error": "The cover exceeds 32 MB."}, 413)
                return
        except (OSError, ValueError, ET.ParseError) as error:
            self.send_json({"error": str(error)}, 502)
            return
        try:
            self.send_bytes(cover, content_type)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_transcript(self, guid, url):
        try:
            if not url or url not in episode_by_guid(guid)["transcripts"]:
                self.send_json({"error": "This transcript is not in the episode feed."}, 404)
                return
            with open_source(url) as response:
                transcript = response.read(TRANSCRIPT_LIMIT + 1)
            if len(transcript) > TRANSCRIPT_LIMIT:
                self.send_json({"error": "The transcript exceeds 5 MB."}, 413)
                return
        except (OSError, ValueError, ET.ParseError) as error:
            self.send_json({"error": str(error)}, 502)
            return
        self.send_bytes(transcript, "text/plain; charset=utf-8")

    def send_video(self, guid):
        with self.companion.lock:
            job = self.companion.job
            video = self.companion.video if job and job["guid"] == guid else None
        if not video or not video.is_file():
            self.send_error(404)
            return
        with video.open("rb") as file:
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Disposition", f'attachment; filename="{video.name}"')
            self.send_header("Content-Length", str(os.fstat(file.fileno()).st_size))
            self.end_headers()
            try:
                shutil.copyfileobj(file, self.wfile)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_POST(self):
        if not self.valid_host():
            return
        path = urlsplit(self.path)
        if self.headers.get("X-Y5YT") != "1" or path.path not in {
                "/api/jobs", "/api/censor-preview", "/api/censor-sound"}:
            self.send_error(403)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if path.path == "/api/censor-sound":
                slot = parse_qs(path.query).get("slot", [""])[0]
                if not 0 < length <= SOUND_LIMIT or slot not in SLOT_IDS:
                    raise ValueError("Choose a valid sound slot and an audio file under 8 MB.")
                if not self.companion.ffmpeg:
                    raise ValueError("FFmpeg was not found.")
                self.companion.save_sound(slot, self.rfile.read(length))
                self.send_json({"slot": slot})
                return
            if not 0 < length <= 64 * 1024:
                raise ValueError("Invalid request size.")
            payload = json.loads(self.rfile.read(length))
            guid = episode_guid(payload.get("guid"))
            edits = edits_from_request(payload.get("edits", []))
            if path.path == "/api/censor-preview":
                start, end = payload.get("start"), payload.get("end")
                if (type(start) is not int or type(end) is not int or not 0 <= start < end
                        or end - start > 20_000 or any(a < start or b > end for a, b, _ in edits)):
                    raise ValueError("Choose a preview window of up to 20 seconds around the edit.")
                if not self.companion.ffmpeg:
                    raise ValueError("FFmpeg was not found.")
                self.send_bytes(self.companion.preview(guid, (start, end), edits), "audio/wav")
                return
            action = payload.get("action")
            if action not in ("render", "transcribe", "both"):
                raise ValueError("Invalid job action.")
            self.send_json(self.companion.start(guid, action, edits if action != "transcribe" else []), 202)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (ValueError, AttributeError, RuntimeError, OSError, ET.ParseError, subprocess.SubprocessError) as error:
            self.send_json({"error": str(error)}, 400)

    def log_message(self, *_):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default=os.environ.get("Y5YT_FFMPEG"))
    parser.add_argument("--output", type=Path, default=Path.home() / "Videos" / "Y5YT")
    parser.add_argument("--port", type=int, default=8755)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="y5yt-audio-") as cache:
        companion = Companion(*find_tools(args.ffmpeg), args.output.expanduser().resolve(), Path(cache))
        with ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, companion=companion)) as server:
            url = f"http://127.0.0.1:{server.server_port}/y5yt/"
            print(f"Y5YT is running at {url}. Keep this window open while a job runs.", flush=True)
            if not args.no_browser:
                webbrowser.open(url)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == "__main__":
    main()
