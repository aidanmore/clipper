"""Shared, dependency-free podcast ingestion and audio helpers."""
import array
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import math
from pathlib import Path
import subprocess
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

FEED = "https://anchor.fm/s/1014cea94/podcast/rss"
ITUNES = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
ROOT = Path(__file__).resolve().parents[1]


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def seconds(value):
    try:
        result = 0
        for part in str(value).split(":"):
            result = result * 60 + float(part)
        return result if math.isfinite(result) and result > 0 else 0
    except ValueError:
        return 0


def load_feed():
    with urlopen(Request(FEED, headers={"User-Agent": "YellowFiveClipper/2"}), timeout=45) as r:
        body = r.read(5 * 1024 * 1024)
    items = ET.fromstring(body).findall("./channel/item")
    episodes = []
    for item in items:
        guid = item.findtext("guid", "").strip()
        enclosure = item.find("enclosure")
        if not guid or enclosure is None:
            continue
        audio = enclosure.get("url", "")
        if urlsplit(audio).scheme != "https":
            continue
        image = item.find(ITUNES + "image")
        try:
            date = parsedate_to_datetime(item.findtext("pubDate")).isoformat()
        except (TypeError, ValueError):
            date = ""
        key = hashlib.sha256(guid.encode()).hexdigest()[:20]
        fingerprint = hashlib.sha256(audio.encode()).hexdigest()[:20]
        episodes.append({"guid": guid, "key": key, "fingerprint": fingerprint,
                         "title": item.findtext("title", "Yellow Five"),
                         "number": item.findtext(ITUNES + "episode", ""),
                         "date": date, "duration": seconds(item.findtext(ITUNES + "duration", "0")),
                         "audio": audio, "cover": image.get("href", "") if image is not None else ""})
    return sorted(episodes, key=lambda e: e["date"], reverse=True)


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)


def download(url, target):
    # Only callers resolving an episode from the fixed public feed may choose this URL.
    with urlopen(Request(url, headers={"User-Agent": "YellowFiveClipper/2"}), timeout=60) as r:
        if urlsplit(r.url).scheme != "https":
            raise ValueError("Audio host redirected to an insecure URL")
        size = 0
        with Path(target).open("wb") as f:
            while block := r.read(256 * 1024):
                size += len(block)
                if size > 1024 ** 3:
                    raise ValueError("Episode exceeds 1 GB")
                f.write(block)
        if not size:
            raise ValueError("Empty episode audio")


def duration(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
                             "default=nw=1:nk=1", str(path)], capture_output=True, text=True,
                            check=True, timeout=60)
    return float(result.stdout.strip())


def analyze(path, episode):
    # 100 envelopes/second keep word-level trimming useful, in a tiny static sidecar.
    result = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-vn",
                             "-ac", "1", "-ar", "1000", "-f", "s16le", "pipe:1"],
                            capture_output=True, check=True, timeout=600)
    samples = array.array("h", result.stdout)
    import sys
    if sys.byteorder != "little":
        samples.byteswap()
    count = len(samples)
    if not count:
        raise ValueError("No audio samples")
    peaks = [round(max(abs(v) for v in samples[i:i + 10]) / 32768 * 255)
             for i in range(0, count, 10)]
    rms = [math.sqrt(sum(v * v for v in samples[i:i + 250]) / len(samples[i:i + 250])) / 32768
           for i in range(0, count, 250)]
    return {"version": 1, "fingerprint": episode["fingerprint"], "duration": count / 1000,
            "peakStep": .01, "peaks": peaks, "energyStep": .25,
            "energy": [round(min(1, v) * 65535) for v in rms], "generatedAt": utc_now()}


def render_clip(source, output, start, end):
    # Re-encode after accurate input seeking; preserve source channels and default sample rate.
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", str(start), "-i", str(source),
                    "-t", str(end - start), "-map", "0:a:0", "-vn", "-c:a", "libmp3lame",
                    "-q:a", "2", "-map_metadata", "-1", str(output)], check=True, timeout=600)
