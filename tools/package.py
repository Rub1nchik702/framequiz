"""Package the Windows release and embed the striped sun in Explorer's icon."""
import argparse
import ctypes
from ctypes import wintypes
import math
from pathlib import Path
import shutil
import struct
import subprocess
import os
import tempfile
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


def sun_png(size):
    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data)))
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            hits = 0
            for dy in (0.25, 0.75):
                for dx in (0.25, 0.75):
                    u, v = (x + dx) * 64 / size, (y + dy) * 64 / size
                    band = v < 32 or 34 <= v < 39 or 42 <= v < 46 or 50 <= v < 53 or 57 <= v < 60
                    hits += band and math.hypot(u - 32, v - 32) <= 30
            pixels.extend((245, 130, 85, round(255 * hits / 4)))
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(pixels))) + chunk(b"IEND", b""))


def embed_sun(executable):
    dll = ctypes.WinDLL("kernel32", use_last_error=True)
    begin = dll.BeginUpdateResourceW
    begin.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
    begin.restype = wintypes.HANDLE
    update = dll.UpdateResourceW
    update.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                       wintypes.WORD, ctypes.c_void_p, wintypes.DWORD]
    end = dll.EndUpdateResourceW
    end.argtypes = [wintypes.HANDLE, wintypes.BOOL]
    handle = begin(str(executable), False)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    sizes = (16, 32, 48, 64, 128, 256)
    group = bytearray(struct.pack("<HHH", 0, 1, len(sizes)))

    def put(kind, index, data):
        if not update(handle, kind, index, 0, data, len(data)):
            raise ctypes.WinError(ctypes.get_last_error())

    try:
        for index, size in enumerate(sizes, 1):
            png = sun_png(size)
            put(3, index, png)
            group.extend(struct.pack("<BBBBHHIH", size % 256, size % 256,
                                     0, 0, 1, 32, len(png), index))
        put(14, 1, bytes(group))
    except Exception:
        end(handle, True)
        raise
    if not end(handle, False):
        raise ctypes.WinError(ctypes.get_last_error())


def build_window(staging, sdk):
    window = staging / "window"
    window.mkdir()
    references = [sdk / "lib/net462" / ("Microsoft.Web.WebView2." + part + ".dll")
                  for part in ("Core", "WinForms")]
    compiler = (Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe")
    updater = staging / "Framequiz-Update.exe"
    subprocess.run([str(compiler), "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
                    "/out:" + str(updater), "/reference:System.Windows.Forms.dll","/reference:System.Drawing.dll",
                    "/reference:System.Net.Http.dll","/reference:System.IO.Compression.dll",
                    "/reference:System.IO.Compression.FileSystem.dll","/reference:System.Security.dll",
                    "/reference:System.Web.Extensions.dll",str(ROOT/"tools/ReleaseClient.cs"),
                    str(ROOT/"tools/UpdateWindow.cs")],check=True)
    embed_sun(updater)
    executable = window / "FramequizWindow.exe"
    subprocess.run([str(compiler), "/nologo", "/target:winexe", "/platform:x64",
                    "/optimize+", "/out:" + str(executable),
                    "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll",
                    "/resource:" + str(updater) + ",Framequiz.Update",
                    *("/reference:" + str(dll) for dll in references),
                    str(ROOT / "tools/StudioWindow.cs")], check=True)
    embed_sun(executable)
    for path in (*references, sdk / "runtimes/win-x64/native/WebView2Loader.dll"):
        shutil.copyfile(path, window / path.name)
    shutil.copyfile(sdk / "LICENSE.txt", window / "WebView2-LICENSE.txt")


def main():
    global DIST
    parser = argparse.ArgumentParser()
    parser.add_argument("--webview-sdk", type=Path, required=True)
    parser.add_argument("--dist", type=Path, default=DIST)
    args = parser.parse_args()
    DIST = args.dist.resolve()
    with tempfile.TemporaryDirectory(dir=DIST) as temp:
        staging = Path(temp)
        executable = staging / "Framequiz.exe"
        shutil.copyfile(ROOT / "target/release/quiz-studio.exe", executable)
        embed_sun(executable)
        build_window(staging, args.webview_sdk.resolve())
        archive = staging / "Framequiz-Windows.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for path in (executable, DIST / "ffmpeg.exe", ROOT / "README.md",
                         DIST / "FFmpeg-COPYING.txt", ROOT / "README.ru.md", ROOT / "tools/Update-Framequiz.ps1"):
                output.write(path, path.name)
            for path in (staging / "window").iterdir():
                output.write(path, "window/" + path.name)
        shutil.copytree(staging / "window", DIST / "window", dirs_exist_ok=True)
        shutil.copyfile(staging / "Framequiz-Update.exe", DIST / "Framequiz-Update.exe")
        archive.replace(DIST / archive.name)
        shutil.copyfile(ROOT / "README.md", DIST / "README.md")
        executable.replace(DIST / executable.name)


if __name__ == "__main__":
    main()

