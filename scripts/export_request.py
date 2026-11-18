"""Process owner-authored clip requests. Never execute request text as shell code."""
import json
import math
import os
from pathlib import Path
import re
import tempfile
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
import zipfile
from podcast import download, duration, load_feed, render_clip


def parse_request(body):
    if not isinstance(body, str) or len(body) > 20000:
        raise ValueError("Request body is too large")
    match = re.search(r"```json\s*\n(.*?)\n```", body, re.S)
    if not match:
        raise ValueError("Missing clip request. Submit it from the clipper export button.")
    data = json.loads(match.group(1))
    if data.get("version") != 1 or not isinstance(data.get("episode"), str):
        raise ValueError("Unsupported request")
    if not re.fullmatch(r"[a-zA-Z0-9-]{8,64}", data.get("request", "")):
        raise ValueError("Invalid request identifier")
    clips = data.get("clips")
    if not isinstance(clips, list) or not 1 <= len(clips) <= 10:
        raise ValueError("Choose between 1 and 10 clips")
    total = 0
    for clip in clips:
        if not isinstance(clip, dict):
            raise ValueError("Invalid clip")
        start, end = clip.get("start"), clip.get("end")
        if any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) for v in (start, end)):
            raise ValueError("Invalid timestamp")
        if not 0 <= start < end or not .5 <= end - start <= 600:
            raise ValueError("Each clip must be between 0.5 seconds and 10 minutes")
        total += end - start
    if total > 1800:
        raise ValueError("An export can contain at most 30 minutes of audio")
    return data


def safe_name(value):
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value)).strip("-")[:60] or "clip"


def github(path, method="GET", data=None, content_type="application/json"):
    raw = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else None
    url = path if path.startswith("https://uploads.github.com/") else "https://api.github.com/repos/" + os.environ["GITHUB_REPOSITORY"] + path
    request = Request(url, data=raw, method=method, headers={
        "Authorization": "Bearer " + os.environ["GH_TOKEN"],
        "Accept": "application/vnd.github+json", "Content-Type": content_type,
        "User-Agent": "YellowFiveClipper/2"})
    with urlopen(request, timeout=120) as response:
        body = response.read()
        return json.loads(body) if body else None


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    issue = event["issue"]
    owner = os.environ["GITHUB_REPOSITORY"].split("/")[0]
    # Check again in code, not only in the workflow condition.
    if issue["user"]["login"].lower() != owner.lower() or not issue["title"].startswith("[clipper export]"):
        raise ValueError("Only the repository owner can request exports")
    number = issue["number"]
    try:
        data = parse_request(issue["body"])
        episode = next((e for e in load_feed() if e["guid"] == data["episode"]), None)
        if not episode:
            raise ValueError("Episode not found in the current feed")
        if data.get("fingerprint") != episode["fingerprint"]:
            raise ValueError("Episode source changed. Refresh the clipper and submit again.")
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "source.mp3"
            download(episode["audio"], source)
            length = duration(source)
            outputs = []
            for i, clip in enumerate(data["clips"], 1):
                if clip["end"] > length + .05:
                    raise ValueError("Clip ends beyond the episode")
                name = f"{i:02d}-yellow-five-{safe_name(episode['number'])}-{safe_name(clip.get('name', 'clip'))}-{clip['start']:.2f}-{clip['end']:.2f}.mp3"
                output = directory / name
                render_clip(source, output, clip["start"], clip["end"])
                if abs(duration(output) - (clip["end"] - clip["start"])) > .2:
                    raise ValueError("Export duration verification failed")
                outputs.append(output)
            if len(outputs) > 1:
                bundle = directory / "yellow-five-clips.zip"
                with zipfile.ZipFile(bundle, "w", zipfile.ZIP_STORED) as archive:
                    for output in outputs:
                        archive.write(output, output.name)
                outputs.append(bundle)
            tag = "clipper-export-" + str(number)
            try:
                release = github("/releases/tags/" + tag)
                if not release["draft"]:
                    github(f"/issues/{number}", "PATCH", {"state": "closed"})
                    return
            except HTTPError as error:
                if error.code != 404:
                    raise
                release = github("/releases", "POST", {
                    "tag_name": tag, "target_commitish": os.environ.get("GITHUB_SHA", "main"),
                    "name": "Clipper export #" + str(number), "draft": True,
                    "prerelease": True, "make_latest": "false",
                    "body": f"Yellow Five clips · request {data['request']}\n\n{episode['title']}\n\nRequested in #{number}."})
            for output in outputs:
                # A retry can safely replace an asset left in an unpublished draft.
                for asset in release.get("assets", []):
                    if asset["name"] == output.name:
                        github(f"/releases/assets/{asset['id']}", "DELETE")
                upload = release["upload_url"].split("{")[0] + "?name=" + quote(output.name)
                github(upload, "POST", output.read_bytes(), "application/zip" if output.suffix == ".zip" else "audio/mpeg")
            release = github(f"/releases/{release['id']}", "PATCH", {"draft": False, "make_latest": "false"})
            github(f"/issues/{number}/comments", "POST", {"body": "Your clips are ready: " + release["html_url"] + "\n\nReturn to the clipper and tap **Check exports** to download them there."})
            github(f"/issues/{number}", "PATCH", {"state": "closed", "state_reason": "completed"})
    except Exception as error:
        github(f"/issues/{number}/comments", "POST", {"body": "Clip export failed: " + str(error)[:500] + "\n\nRefresh the clipper and submit a new request, or check the Actions run."})
        raise


if __name__ == "__main__":
    main()
