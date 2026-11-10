"""Loopback-only Y5YT companion. Run with Python 3.10 or newer."""

import argparse
from functools import partial
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
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
import webbrowser
import xml.etree.ElementTree as ET


FEED = "https://anchor.fm/s/1014cea94/podcast/rss"
ITUNES = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
TRANSCRIPT_LIMIT = 5 * 1024 * 1024
PAGE = Path(__file__).resolve().parent
STATIC = {"/y5yt/": "index.html", "/y5yt/index.html": "index.html",
          "/y5yt/style.css": "style.css", "/y5yt/app.js": "app.js",
          "/y5yt/topics.js": "topics.js", "/pcrp.ico": "../pcrp.ico"}
STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".js": "text/javascript; charset=utf-8", ".ico": "image/x-icon"}
SQUARE = ("scale=1080:1080:force_original_aspect_ratio=decrease,"
          "pad=1080:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p")


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
    with open_source(FEED) as response:
        return response.read(4 * 1024 * 1024)


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


def audio_duration(ffprobe, path):
    result = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=duration:format=duration", "-of", "json", str(path)],
        capture_output=True, check=True, text=True, timeout=30,
    )
    data = json.loads(result.stdout)
    if not data.get("streams"):
        raise ValueError("FFprobe found no audio stream.")
    duration = data["streams"][0].get("duration")
    return float(duration if duration not in (None, "N/A") else data["format"]["duration"])


def render(ffmpeg, ffprobe, audio, cover, work, destination, update):
    log = work / "ffmpeg.log"
    update("Encoding the original episode audio", 0)
    source_duration = audio_duration(ffprobe, audio)
    encoded_audio = work / "episode.m4a"
    ffmpeg_run(ffmpeg, ["-i", audio, "-map", "0:a:0", "-map_metadata", "-1",
                        "-c:a", "aac", "-b:a", "256k", "-ar", "48000", encoded_audio],
               log, lambda time: update("Encoding the original episode audio", time / source_duration))
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
    def __init__(self, ffmpeg, ffprobe, output):
        self.ffmpeg, self.ffprobe = ffmpeg, ffprobe
        self.output = output
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

    def start(self, guid, action):
        if not self.ffmpeg:
            raise ValueError("FFmpeg and FFprobe were not found. Restart with --ffmpeg pointing to ffmpeg.exe.")
        if action in {"transcribe", "both"} and not self.whisper:
            raise ValueError("Install faster-whisper, then restart Y5YT to transcribe automatically.")
        with self.lock:
            if self.job and self.job["state"] == "running":
                raise ValueError("An episode is already being processed.")
            previous = self.job if self.job and self.job["guid"] == guid else {}
            if not previous:
                self.video = None
            self.job = {"guid": guid, "state": "running", "stage": "Reading the episode feed",
                        "progress": None, "video": previous.get("video"),
                        "transcript": previous.get("transcript"), "error": None}
            initial = dict(self.job)
            Thread(target=self.process, args=(guid, action), daemon=True).start()
            return initial

    def process(self, guid, action):
        def progress(stage, percent=None):
            self.update(stage=stage, progress=None if percent is None else min(1, max(0, percent)))

        try:
            episode = episode_by_guid(guid)
            with tempfile.TemporaryDirectory(prefix="y5yt-") as temp:
                work = Path(temp)
                audio = work / "source.mp3"
                cover = work / "cover.image"
                progress("Downloading the full episode audio")
                download(episode["audio"], audio, 1024**3,
                         partial(progress, "Downloading the full episode audio"))
                if action in {"render", "both"}:
                    if not episode["cover"]:
                        raise ValueError("This episode has no individual cover in the feed.")
                    progress("Downloading the episode cover")
                    download(episode["cover"], cover, 32 * 1024**2,
                             partial(progress, "Downloading the episode cover"))
                    slug = re.sub(r"[^a-z0-9]+", "-", episode["title"].lower()).strip("-")[:64]
                    number = re.sub(r"\D", "", episode["number"])
                    name = "-".join(filter(None, ("yellow-five", number, slug))) + ".mp4"
                    destination = self.output / name
                    render(self.ffmpeg, self.ffprobe, audio, cover, work, destination, progress)
                    with self.lock:
                        self.video = destination
                        self.job["video"] = name
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
                            "output": str(self.companion.output), "job": self.companion.snapshot()})
        elif path.path == "/api/feed":
            try:
                self.send_bytes(feed_xml(), "application/rss+xml; charset=utf-8")
            except (OSError, ValueError) as error:
                self.send_json({"error": str(error)}, 502)
        elif path.path == "/api/video":
            self.send_video(parse_qs(path.query).get("guid", [""])[0])
        elif path.path == "/api/transcript":
            params = parse_qs(path.query)
            self.send_transcript(params.get("guid", [""])[0], params.get("url", [""])[0])
        else:
            self.send_error(404)

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
        if self.path != "/api/jobs" or self.headers.get("X-Y5YT") != "1":
            self.send_error(403)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 1024:
                raise ValueError("Invalid job request.")
            request = json.loads(self.rfile.read(length))
            guid, action = request.get("guid"), request.get("action")
            if not isinstance(guid, str) or not re.fullmatch(r"[\w.-]{1,128}", guid):
                raise ValueError("Invalid episode identifier.")
            if action not in ("render", "transcribe", "both"):
                raise ValueError("Invalid job action.")
            self.send_json(self.companion.start(guid, action), 202)
        except (ValueError, AttributeError) as error:
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
    companion = Companion(*find_tools(args.ffmpeg), args.output.expanduser().resolve())
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
