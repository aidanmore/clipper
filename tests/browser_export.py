"""Exercise the real browser decoder, worker encoder, and downloaded audio."""
import array
import contextlib
import functools
import http.server
import json
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from prepare_audio import seek_table


def run():
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("Browser export checks timed out")))
    signal.alarm(180)
    with tempfile.TemporaryDirectory() as tmp:
        temp = Path(tmp)
        sources = {}
        for tagged in (False, True):
            source = temp / ("tagged.mp3" if tagged else "plain.mp3")
            # Different evolving signals on L/R expose wrong offsets and stereo loss.
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                "aevalsrc=0.5*sin(2*PI*(170*t+13*t*t))|0.4*sin(2*PI*(410*t+21*t*t)):s=44100:d=44",
                "-c:a", "libmp3lame", "-b:a", "192k", "-write_xing", str(int(tagged)),
                "-id3v2_version", "3" if tagged else "0", str(source)], check=True)
            info = seek_table(source)
            info["chunkSize"] = 128 * 1024  # Force clips across shard boundaries.
            info["fingerprint"] = "tagged" if tagged else "plain"
            sources[info["fingerprint"]] = (info, source.read_bytes())
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with sync_playwright() as p:
                for browser_type in (p.chromium, p.webkit):
                    print("Starting", browser_type.name, flush=True)
                    browser = browser_type.launch(headless=True)
                    page = browser.new_page()
                    page.on("console", lambda message: print("Browser:", message.text, flush=True))
                    page.on("pageerror", lambda error: print("Page error:", error, flush=True))
                    page.goto(f"http://127.0.0.1:{server.server_port}/tests/export-harness.html")
                    def audio(route):
                        url = route.request.url
                        which = "tagged" if "/tagged/" in url else "plain"
                        info, data = sources[which]
                        if url.endswith("manifest.json"):
                            route.fulfill(body=json.dumps(info), headers={"Access-Control-Allow-Origin": "*"}, content_type="application/json")
                        else:
                            n = int(url.rsplit("/", 1)[1].split(".")[0]); size = info["chunkSize"]
                            route.fulfill(body=data[n*size:(n+1)*size], headers={"Access-Control-Allow-Origin": "*"}, content_type="application/octet-stream")
                    page.route("https://raw.githubusercontent.com/aidanmore/clipper/clipper-audio-*/**", audio)
                    for which, (info, raw) in sources.items():
                        # Native full-file decoding is the timestamp reference.
                        def reference(route):
                            route.fulfill(body=raw, content_type="audio/mpeg")
                        page.route("**/reference.mp3", reference)
                        result = page.evaluate("""async ({which}) => {
                            const ctx = new AudioContext({sampleRate:44100});
                            const reference = await ctx.decodeAudioData(await (await fetch('reference.mp3')).arrayBuffer());
                            const episode = {key:'80000000000000000000', fingerprint:which};
                            const results = [];
                            for (const [start,end] of [[0,1.25],[1.25,3.5],[5.13,8.87],[19.77,42.12]]) {
                                console.log('Cutting',which,start,end);
                                const cut = await DirectExport.clip(episode,{start,end},{format:'wav',signal:AbortSignal.timeout(20000)});
                                const buffer = await ctx.decodeAudioData(await cut.blob.arrayBuffer());
                                const first=Math.round(start*44100), count=Math.round(end*44100)-first;
                                let err=0, energy=0, stereo=0;
                                for(let c=0;c<2;c++) for(let i=0;i<count;i++) {
                                    const x=reference.getChannelData(c)[first+i],y=buffer.getChannelData(c)[i];
                                    err+=(x-y)*(x-y); energy+=y*y;
                                    if(c===0) stereo+=Math.abs(y-buffer.getChannelData(1)[i]);
                                }
                                results.push({start,end,length:buffer.length,expected:count,channels:buffer.numberOfChannels,error:Math.sqrt(err/(count*2)),rms:Math.sqrt(energy/(count*2)),stereo:stereo/count});
                            }
                            const mp3=await DirectExport.clip(episode,{start:1.25,end:3.5},{format:'mp3',signal:AbortSignal.timeout(20000)});
                            const decoded=await ctx.decodeAudioData(await mp3.blob.arrayBuffer());
                            const link=document.createElement('a');link.download='verified-clip.mp3';link.href=URL.createObjectURL(mp3.blob);link.textContent='Save test clip';document.body.append(link);
                            await ctx.close();
                            return {results,mp3:{duration:decoded.duration,channels:decoded.numberOfChannels,size:mp3.blob.size}};
                        }""", {"which": which})
                        print(browser_type.name, which, json.dumps(result), flush=True)
                        for clip in result["results"]:
                            assert clip["length"] == clip["expected"], clip
                            assert clip["channels"] == 2 and clip["rms"] > .1 and clip["stereo"] > .1, clip
                            assert clip["error"] < .002, clip
                        assert abs(result["mp3"]["duration"] - 2.25) < .12, result
                        assert result["mp3"]["channels"] == 2 and result["mp3"]["size"] > 10000, result
                        with page.expect_download() as event:
                            page.get_by_role("link", name="Save test clip").click()
                        output = temp / (browser_type.name + "-" + which + ".mp3")
                        event.value.save_as(output)
                        assert output.stat().st_size > 10000
                        page.get_by_role("link", name="Save test clip").evaluate("e=>e.remove()")
                    page.unroute("https://raw.githubusercontent.com/aidanmore/clipper/clipper-audio-*/**")
                    episode = json.loads((ROOT / "data/catalog.json").read_text())["episodes"][0]
                    real = page.evaluate("""async (episode) => {
                        const cut=await DirectExport.clip(episode,{start:1.25,end:3.5},{format:'mp3',signal:AbortSignal.timeout(30000)});
                        const ctx=new AudioContext(),audio=await ctx.decodeAudioData(await cut.blob.arrayBuffer());
                        let energy=0;for(const x of audio.getChannelData(0))energy+=x*x;
                        await ctx.close();
                        return {duration:audio.duration,channels:audio.numberOfChannels,rms:Math.sqrt(energy/audio.length),bytes:cut.blob.size};
                    }""", episode)
                    print(browser_type.name, "LIVE CORS AND EXPORT", json.dumps(real), flush=True)
                    assert abs(real["duration"]-2.25)<.12 and real["channels"]==2 and real["rms"]>.001,real
                    browser.close()
        finally:
            server.shutdown()


if __name__ == "__main__":
    run()
