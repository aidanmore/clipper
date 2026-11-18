import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from export_request import parse_request, safe_name
from podcast import analyze, duration, render_clip


class ExportTests(unittest.TestCase):
    def body(self, clips):
        return '```json\n' + json.dumps({"version": 1, "episode": "abc", "request": "12345678-abcd", "clips": clips}) + '\n```'

    def test_rejects_invalid_timestamps_and_overlong_exports(self):
        for clip in [{"start": -1, "end": 5}, {"start": 2, "end": 1}, {"start": True, "end": 3},
                     {"start": math.nan, "end": 4}, {"start": 0, "end": 601}]:
            with self.subTest(clip=clip), self.assertRaises(ValueError):
                parse_request(self.body([clip]))
        with self.assertRaises(ValueError):
            parse_request(self.body([{"start": 0, "end": 600}] * 4))

    def test_valid_request_and_safe_names(self):
        data = parse_request(self.body([{"start": 1.25, "end": 3.5, "name": "A moment"}]))
        self.assertEqual(data["clips"][0]["start"], 1.25)
        self.assertNotIn("/", safe_name('../../$(rm -rf)'))

    def test_stereo_clip_preserves_channels_and_exact_region(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp)/"source.wav", Path(temp)/"cut.mp3"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                            "aevalsrc=sin(2*PI*440*t)|sin(2*PI*880*t):s=44100:d=5", str(source)], check=True)
            render_clip(source, output, 1.25, 3.5)
            self.assertLess(abs(duration(output) - 2.25), .1)
            result = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "stream=channels", "-of", "csv=p=0", str(output)], text=True)
            self.assertEqual(result.strip(), "2")
            sidecar = analyze(source, {"fingerprint": "test"})
            self.assertAlmostEqual(sidecar["duration"], 5, places=1)
            self.assertEqual(len(sidecar["peaks"]), 500)


if __name__ == '__main__':
    unittest.main()
