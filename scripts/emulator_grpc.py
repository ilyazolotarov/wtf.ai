"""The Android emulator's gRPC control interface (emulator started with `-grpc <port>`), for the store-video scripts:
its screen stream (emulator-record.py), GPS with a course and the phone's rotation (store-screenshots.py).

Needs `pip install grpcio grpcio-tools`. The stubs are generated from the proto that ships with the installed emulator,
so they always match it.
"""
import importlib
import os
import sys
import tempfile


def stubs():
    """(messages, services) modules of the emulator's EmulatorController."""
    sdk = os.environ.get("ANDROID_HOME") or os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk")
    proto = os.path.join(sdk, "emulator", "lib", "emulator_controller.proto")
    out = os.path.join(tempfile.gettempdir(), "wtf-emulator-grpc")
    os.makedirs(out, exist_ok=True)
    if not os.path.exists(os.path.join(out, "emulator_controller_pb2_grpc.py")):
        import grpc_tools
        from grpc_tools import protoc

        well_known = os.path.join(os.path.dirname(grpc_tools.__file__), "_proto")  # google/protobuf/empty.proto
        if protoc.main(["protoc", f"-I{os.path.dirname(proto)}", f"-I{well_known}", f"--python_out={out}",
                        f"--grpc_python_out={out}", proto]):
            raise SystemExit(f"could not compile {proto}")
    if out not in sys.path:
        sys.path.insert(0, out)
    return importlib.import_module("emulator_controller_pb2"), importlib.import_module("emulator_controller_pb2_grpc")


def connect(port):
    """(messages module, EmulatorController stub) on 127.0.0.1:`port`; screenshots are bigger than gRPC's 4 MB default."""
    import grpc

    pb, rpc = stubs()
    channel = grpc.insecure_channel(f"127.0.0.1:{port}", options=[("grpc.max_receive_message_length", 64 << 20)])
    return pb, rpc.EmulatorControllerStub(channel)
