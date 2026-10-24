#!/usr/bin/env python3
"""Records the Android emulator's screen to MP4 from its gRPC screen stream, encoding on the GPU (NVENC).

The emulator's own recorder (`adb emu screenrecord`) encodes VP9 in software on one host thread: at a rate high enough
to keep the dark map sharp it drops to ~16-44 fps. This takes frames from the emulator itself (no screen capture, so
it records with the laptop's screen off or locked and the window covered), through shared memory (MMAP transport,
~58 fps at 1080x2400 measured; the plain gRPC path managed ~48), and pipes them to ffmpeg at a constant frame rate
(--fps, 60 by default).

Needs the emulator started with `-grpc <port>` and `pip install grpcio grpcio-tools`. Runs until Ctrl+C or until
`<out>.stop` exists (how scripts/store-screenshots.py stops it: a terminate on Windows would kill it before ffmpeg
finishes the file), then finishes the file. --audio also records what the emulator plays (its gRPC audio stream,
48 kHz stereo, silence filled in where it sends nothing) and muxes it in as AAC.

    python scripts/emulator-record.py out.mp4 [--port 8554] [--crop 1080:2160:0:120] [--fps 30] [--audio]
"""
import argparse
import mmap
import os
import signal
import subprocess
import tempfile
import threading
import time
import wave

from emulator_grpc import connect

RATE, CHANNELS = 48000, 2


def record_audio(pb, stub, path, stop, t0):
    """The emulator's audio output into a WAV that starts at `t0` (perf_counter). Each packet goes where its own
    timestamp (µs) puts it: packets reach us in bursts when the host is busy, so placing them by our clock would cut
    silence into the middle of a sound. Only a real gap in the stream, and the time up to the stop (else the mux,
    which ends with the shorter stream, would cut the video), are filled with zeros."""
    fmt = pb.AudioFormat(samplingRate=RATE, channels=pb.AudioFormat.Stereo, format=pb.AudioFormat.AUD_FMT_S16,
                         mode=pb.AudioFormat.MODE_REAL_TIME)
    frame = 2 * CHANNELS
    stream = stub.streamAudio(fmt)
    threading.Thread(target=lambda: (stop.wait(), stream.cancel()), daemon=True).start()
    written = 0
    first = None  # (the first packet's timestamp, where it went)
    with wave.open(path, "wb") as w:
        w.setnchannels(CHANNELS)
        w.setsampwidth(2)
        w.setframerate(RATE)
        try:
            for packet in stream:
                if first is None:
                    first = (packet.timestamp, int((time.perf_counter() - t0) * RATE))
                at = first[1] + (packet.timestamp - first[0]) * RATE // 1_000_000
                gap = at - written
                if gap > RATE // 50:  # 20 ms the stream skipped
                    w.writeframes(bytes(1) * gap * frame)
                    written += gap
                w.writeframes(packet.audio)
                written += len(packet.audio) // frame
        except Exception:  # cancelled: stopped
            pass
        behind = int((time.perf_counter() - t0) * RATE) - written
        if behind > 0:
            w.writeframes(bytes(1) * behind * frame)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out")
    ap.add_argument("--port", type=int, default=8554)
    ap.add_argument("--crop", help="ffmpeg crop w:h:x:y, e.g. the `wm size` area letterboxed in the display")
    ap.add_argument("--fps", type=int, default=60, help="the video's constant frame rate")
    ap.add_argument("--audio", action="store_true", help="also record the emulator's sound")
    args = ap.parse_args()

    import grpc

    pb, stub = connect(args.port)
    probe = stub.getScreenshot(pb.ImageFormat(format=pb.ImageFormat.RGB888))
    w, h = probe.format.width, probe.format.height
    size = w * h * 3

    shm_path = os.path.join(tempfile.gettempdir(), f"wtf-emulator-frame-{os.getpid()}.raw")
    with open(shm_path, "wb") as f:
        f.truncate(size)
    shm_file = open(shm_path, "r+b")
    shm = mmap.mmap(shm_file.fileno(), size)
    fmt = pb.ImageFormat(format=pb.ImageFormat.RGB888, width=w, height=h)
    fmt.transport.channel = pb.ImageTransport.MMAP
    fmt.transport.handle = "file:///" + shm_path.replace("\\", "/")

    # Each new frame goes through the pipe once, stamped with the time ffmpeg reads it; ffmpeg repeats frames itself to
    # make a constant frame rate. (Writing the repeats from here moved ~470 MB/s through the pipe and halved the new frames.)
    vf = ([f"crop={args.crop}"] if args.crop else []) + [f"fps={args.fps}"]
    video_out = args.out + ".video.mp4" if args.audio else args.out
    ffmpeg = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-use_wallclock_as_timestamps", "1", "-pix_fmt", "rgb24",
         "-s", f"{w}x{h}", "-i", "-", "-vf", ",".join(vf), "-fps_mode", "cfr",
         # Constant quality on the GPU: high enough that the dark map keeps its texture (the site re-encodes smaller).
         "-c:v", "h264_nvenc", "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "16", "-b:v", "0",
         "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", str(args.fps), "-movflags", "+faststart", video_out],
        stdin=subprocess.PIPE, bufsize=0,
    )

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stop_file = args.out + ".stop"
    if os.path.exists(stop_file):
        os.remove(stop_file)
    stream = stub.streamScreenshot(fmt)
    t0 = time.perf_counter()
    wav = args.out + ".wav"
    audio = threading.Thread(target=record_audio, args=(pb, stub, wav, stop, t0), daemon=True) if args.audio else None
    if audio:
        audio.start()

    def watch():
        # The stream sends nothing while the screen is still: cancelling it is what ends the loop below.
        while not stop.is_set() and not os.path.exists(stop_file):
            time.sleep(0.2)
        stop.set()
        stream.cancel()

    threading.Thread(target=watch, daemon=True).start()
    received, first = 0, None
    try:
        for img in stream:
            if not img.format.width:
                continue
            # Copied out at once: the emulator overwrites the shared frame in place.
            last = shm[:]
            ffmpeg.stdin.write(last)
            received += 1
            first = first or time.perf_counter()
    except grpc.RpcError:  # cancelled: stopped
        pass
    if received:
        ffmpeg.stdin.write(last)  # now: a still screen at the end stays in the video until the stop
    ffmpeg.stdin.close()
    ffmpeg.wait()
    if audio:
        audio.join(timeout=10)
        # The video starts at its first frame; the WAV at the stream's start.
        offset = (first - t0) if first else 0.0
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", video_out, "-ss", f"{offset:.3f}", "-i", wav, "-map", "0:v", "-map", "1:a",
             "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", args.out],
            check=True)
        os.remove(video_out)
        os.remove(wav)
    shm.close()
    shm_file.close()
    os.remove(shm_path)
    if os.path.exists(stop_file):
        os.remove(stop_file)
    took = time.perf_counter() - first if first else 0
    print(f"video {args.out}: {received} frames in {took:.1f} s ({received / took if took else 0:.1f} new frames/s)")


if __name__ == "__main__":
    main()
