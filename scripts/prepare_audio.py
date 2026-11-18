"""Publish unchanged MP3 bytes on sparse audio branches for browser-side cutting.

The site stays small. Audio is split into 4 MiB objects on four separate branches;
the browser fetches only the objects touching its selection. Nothing is re-encoded.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from podcast import ROOT, download, load_feed, utc_now

CHUNK = 4 * 1024 * 1024


def seek_table(source):
    raw = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_packets",
        "-show_streams", "-show_entries",
        "stream=codec_name,sample_rate,channels,start_time:packet=pts_time,pos,size,duration_time",
        "-of", "json", str(source)], timeout=180)
    probe = json.loads(raw)
    stream = probe["streams"][0]
    if stream["codec_name"] != "mp3":
        raise ValueError("This source is not MP3")
    origin = float(stream.get("start_time", 0))
    table, next_time, duration = [], 0, 0
    for packet in probe["packets"]:
        time = float(packet["pts_time"]) - origin
        duration = time + float(packet["duration_time"])
        if not table or time >= next_time:
            table.append([round(time, 8), int(packet["pos"])])
            next_time = time + .5
    return {"version": 1, "sampleRate": int(stream["sample_rate"]),
            "channels": int(stream["channels"]), "duration": duration,
            "size": source.stat().st_size, "chunkSize": CHUNK, "seek": table}


def git(*args, **kwargs):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], **kwargs).decode().strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", type=int, default=0)
    parser.add_argument("--buckets", type=int, default=4)
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()
    episodes = [e for e in load_feed() if int(e["key"][0], 16) % args.buckets == args.bucket]
    branch = "clipper-audio-" + str(args.bucket)
    parent = None
    # Partial fetches don't download the existing audio archive onto each runner.
    if git("ls-remote", "--heads", "origin", "refs/heads/" + branch):
        git("fetch", "--depth=1", "--filter=blob:none", "origin", branch)
        parent = git("rev-parse", "FETCH_HEAD")
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(tmp) / "audio-index"))
        git("read-tree", parent or "--empty", env=env)
        def put(path, body):
            sha = git("hash-object", "-w", "--stdin", input=body)
            git("update-index", "--add", "--cacheinfo", "100644," + sha + "," + path, env=env)
        done, errors = 0, []
        for episode in episodes:
            path = episode["key"] + "/" + episode["fingerprint"]
            if parent:
                try:
                    existing = json.loads(git("show", parent + ":" + path + "/manifest.json"))
                    if existing.get("fingerprint") == episode["fingerprint"]:
                        continue
                except (subprocess.CalledProcessError, ValueError):
                    pass
            if done >= args.limit:
                break
            try:
                print("Preparing direct downloads:", episode["title"], flush=True)
                source = Path(tmp) / "episode.mp3"
                download(episode["audio"], source)
                manifest = seek_table(source)
                manifest.update(fingerprint=episode["fingerprint"], generatedAt=utc_now())
                with source.open("rb") as audio:
                    number = 0
                    while block := audio.read(CHUNK):
                        put(path + f"/{number:04d}.bin", block)
                        number += 1
                put(path + "/manifest.json", json.dumps(manifest, separators=(",", ":")).encode())
                tree = git("write-tree", env=env)
                parents = ["-p", parent] if parent else []
                commit = git("commit-tree", tree, *parents, "-m", "Prepare direct audio: " + episode["title"])
                git("push", "origin", commit + ":refs/heads/" + branch)
                parent = commit
                source.unlink()
                done += 1
                print("Ready:", episode["title"], flush=True)
            except Exception as error:
                errors.append(str(error))
                print("Could not prepare", episode["title"], error, flush=True)
                # Discard a partly staged episode before continuing.
                git("read-tree", parent or "--empty", env=env)
                if len(errors) >= 3:
                    break
        print(f"Direct audio bucket {args.bucket}: {done} prepared, {len(errors)} errors", flush=True)
        if errors:
            raise RuntimeError("Some episode downloads failed; the next scheduled run will retry")


if __name__ == "__main__":
    main()
