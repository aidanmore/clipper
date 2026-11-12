"""Replace short sections of decoded audio without shifting the episode."""

from array import array
from math import pi, sin
import sys


RATE = 48_000
SLOT_IDS = ("sound-1", "sound-2", "sound-3")
MAX_EDITS = 200
MAX_EDIT_MS = 10_000
SAMPLE_SIZE = 4


def edits_from_request(value):
    if not isinstance(value, list) or len(value) > MAX_EDITS:
        raise ValueError(f"Use at most {MAX_EDITS} censor edits per episode.")
    edits = []
    for edit in value:
        if not isinstance(edit, dict):
            raise ValueError("Invalid censor edit.")
        start, end, sound = (edit.get(key) for key in ("start", "end", "sound"))
        if (type(start) is not int or type(end) is not int or not 0 <= start < end
                or not 20 <= end - start <= MAX_EDIT_MS):
            raise ValueError("Choose a censor range between 0.02 and 10 seconds.")
        if sound not in ("bleep", *SLOT_IDS):
            raise ValueError("Choose a replacement sound.")
        edits.append((start, end, sound))
    edits.sort()
    if any(first[1] > second[0] for first, second in zip(edits, edits[1:])):
        raise ValueError("Censor ranges must not overlap. Adjust their start or end times.")
    return edits


def get_sounds(edits, directory):
    sounds = {}
    for _, _, sound in edits:
        if sound in SLOT_IDS and sound not in sounds:
            try:
                sounds[sound] = (directory / (sound + ".pcm")).read_bytes()
            except FileNotFoundError:
                raise ValueError(f"Load a clip into {sound.replace('-', ' ')} first.") from None
    return sounds


def replacement(sound, samples, channels, sounds):
    if sound == "bleep":
        mono = array("f", (0.19 * sin(2 * pi * 900 * i / RATE) for i in range(samples)))
    else:
        mono = array("f")
        mono.frombytes(sounds[sound][:samples * SAMPLE_SIZE])
        if sys.byteorder != "little":
            mono.byteswap()
    fade = min(RATE // 200, len(mono) // 2)
    for i in range(fade):
        gain = i / fade
        mono[i] = mono[i] * gain
        mono[-i - 1] = mono[-i - 1] * gain
    mono.extend(array("f", [0]) * (samples - len(mono)))
    if channels != 1:
        mono = array("f", (sample for sample in mono for _ in range(channels)))
    if sys.byteorder != "little":
        mono.byteswap()
    return mono.tobytes()


def apply_edits(path, channels, edits, sounds, offset=0):
    frame_size = channels * SAMPLE_SIZE
    available = path.stat().st_size // frame_size
    with path.open("r+b") as audio:
        for start, end, sound in edits:
            first = (start - offset) * (RATE // 1000)
            last = (end - offset) * (RATE // 1000)
            if first < 0 or last > available:
                raise ValueError("A censor range extends beyond the episode audio.")
            audio.seek(first * frame_size)
            audio.write(replacement(sound, last - first, channels, sounds))

