"""Refresh catalog and incrementally backfill waveform/energy sidecars."""
import argparse
import json
import tempfile
from pathlib import Path
from podcast import ROOT, analyze, download, load_feed, utc_now, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=4)
    args = parser.parse_args()
    episodes = load_feed()
    catalog = ROOT / "data/catalog.json"
    try:
        previous = json.loads(catalog.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        previous = {}
    if previous.get("episodes") != episodes:
        write_json(catalog, {"version": 1, "updatedAt": utc_now(), "episodes": episodes})
    completed = 0
    errors = []
    for episode in episodes:
        path = ROOT / "data/analysis" / (episode["key"] + ".json")
        if path.exists():
            try:
                if json.loads(path.read_text())["fingerprint"] == episode["fingerprint"]:
                    continue
            except (ValueError, KeyError):
                pass
        if completed >= args.limit:
            break
        try:
            print("Preparing", episode["title"], flush=True)
            with tempfile.TemporaryDirectory() as temp:
                source = Path(temp) / "episode.mp3"
                download(episode["audio"], source)
                write_json(path, analyze(source, episode))
            completed += 1
        except Exception as error:
            errors.append(str(error))
            print("Could not prepare", episode["title"], error, flush=True)
            # Bound attempts even if the host is unavailable.
            if len(errors) >= 3:
                break
    print(f"Catalog: {len(episodes)} episodes; prepared {completed}; errors {len(errors)}")
    if errors and not completed:
        raise RuntimeError("No requested analysis jobs completed")


if __name__ == "__main__":
    main()
