#!/usr/bin/env python3
"""Records the Android emulator's screen to MP4 from its gRPC screen stream, encoding on the GPU (NVENC).

The emulator's own recorder (`adb emu screenrecord`) encodes VP9 in software on one host thread: at a rate high enough
to keep the dark map sharp it drops to ~16-44 fps. This takes frames from the emulator itself (no screen capture, so
it records with the laptop's screen off or locked and the window covered), through shared memory (MMAP transport,
~58 fps at 1080x2400 measured; the plain gRPC path managed ~48), and pipes them to ffmpeg at a constant frame rate
(--fps, 60 by default).

Needs the emulator started with `-grpc <port>` and `pip install grpcio grpcio-tools`. Runs until Ctrl+C or until
`<out>.stop` exists (how scripts/store-screenshots.py stops it: a terminate on Windows would kill it before ffmpeg
finishes the file), then finishes the file.

    python scripts/emulator-record.py out.mp4 [--port 8554] [--crop 1080:2160:0:120] [--fps 30]
"""
import argparse
import mmap
import os
import signal
import subprocess
import tempfile
import threading
import time

from emulator_grpc import connect



def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out")
    ap.add_argument("--port", type=int, default=8554)
    ap.add_argument("--crop", help="ffmpeg crop w:h:x:y, e.g. the `wm size` area letterboxed in the display")
    ap.add_argument("--fps", type=int, default=60, help="the video's constant frame rate")
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
    ffmpeg = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-use_wallclock_as_timestamps", "1", "-pix_fmt", "rgb24",
         "-s", f"{w}x{h}", "-i", "-", "-vf", ",".join(vf), "-fps_mode", "cfr",
         # Constant quality on the GPU: high enough that the dark map keeps its texture (the site re-encodes smaller).
         "-c:v", "h264_nvenc", "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "16", "-b:v", "0",
         "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", str(args.fps), "-movflags", "+faststart", args.out],
        stdin=subprocess.PIPE, bufsize=0,
    )

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stop_file = args.out + ".stop"
    if os.path.exists(stop_file):
        os.remove(stop_file)
    stream = stub.streamScreenshot(fmt)

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
    shm.close()
    shm_file.close()
    os.remove(shm_path)
    if os.path.exists(stop_file):
        os.remove(stop_file)
    took = time.perf_counter() - first if first else 0
    print(f"video {args.out}: {received} frames in {took:.1f} s ({received / took if took else 0:.1f} new frames/s)")


if __name__ == "__main__":
    main()
