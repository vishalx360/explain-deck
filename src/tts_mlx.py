#!/usr/bin/env python3
# /// script
# requires-python = "==3.11.*"
# dependencies = [
#   "mlx-audio==0.5.1",
#   "misaki[en]==0.9.4",
#   "numpy<2",
#   "spacy>=3.8,<4",
#   "en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
# ]
# [tool.uv]
# prerelease = "allow"
# exclude-newer = "2026-11-01T00:00:00Z"
# ///
"""Fast text-to-speech backend for Apple Silicon, run with `uv run`.

The block above is the whole install recipe: uv reads it, builds a cached
environment on first use, and reuses it after. exclude-newer freezes the
resolution so a new upstream release can never quietly change the voice.
misaki needs the spaCy English model, which it would otherwise try to pip
install at runtime - and a uv environment has no pip.

Reads one JSON request per line on stdin and answers one JSON line on stdout,
so the Kokoro weights load once for a whole deck instead of once per clip.

    {"text": "...", "out": "/abs/path.wav", "voice": "af_heart", "speed": 1.0}
 -> {"ok": true, "duration": 4.125}
"""
import json
import os
import sys
import wave

MODEL = os.environ.get("EXPLAIN_MLX_MODEL", "mlx-community/Kokoro-82M-bf16")


def main():
    # generate_audio prints a banner to stdout regardless of verbose, which would
    # corrupt the protocol. Dup the real stdout aside for protocol lines, then
    # point fd 1 at devnull. Real failures still surface: they raise, and
    # tracebacks go to stderr, which the parent inherits.
    proto = os.fdopen(os.dup(sys.stdout.fileno()), "w")
    os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())

    def reply(obj):
        proto.write(json.dumps(obj) + "\n")
        proto.flush()

    from mlx_audio.tts.generate import generate_audio
    from mlx_audio.tts.utils import load_model

    model = load_model(model_path=MODEL)
    reply({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            out = os.path.abspath(req["out"])
            prefix, _, ext = os.path.basename(out).rpartition(".")
            # stream=True opens the output audio device even with play=False,
            # which fails on headless machines and anywhere the speakers are busy.
            generate_audio(
                text=req["text"],
                model=model,
                voice=req.get("voice", "af_heart"),
                speed=float(req.get("speed", 1.0)),
                output_path=os.path.dirname(out),
                file_prefix=prefix,
                audio_format=ext or "wav",
                join_audio=True,
                play=False,
                stream=False,
                verbose=False,
            )
            with wave.open(out) as w:
                duration = w.getnframes() / w.getframerate()
            reply({"ok": True, "duration": duration})
        except Exception as e:
            reply({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
