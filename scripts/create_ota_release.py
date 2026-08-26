from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path


VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
SOURCE_VERSION_RE = re.compile(
    r'constexpr\s+char\s+kFirmwareVersion\[\]\s*=\s*"([^"]+)"\s*;'
)
DEFAULT_REPOSITORY = "ProccyBoi/TramTrace"


def source_version(source_path: Path) -> str:
    match = SOURCE_VERSION_RE.search(source_path.read_text(encoding="utf-8"))
    if not match:
        raise ValueError(f"kFirmwareVersion was not found in {source_path}")
    version = match.group(1)
    if not VERSION_RE.fullmatch(version):
        raise ValueError(f"firmware version must be X.Y.Z, got {version!r}")
    return version


def signed_payload(version: str, size: int, sha256: str) -> bytes:
    return f"tramtrace-ota-v1\n{version}\n{size}\n{sha256}\n".encode("ascii")


def sign_payload(payload: bytes, private_key: Path) -> str:
    result = subprocess.run(
        [
            "openssl",
            "dgst",
            "-sha256",
            "-sign",
            str(private_key),
        ],
        input=payload,
        check=True,
        capture_output=True,
    )
    return base64.b64encode(result.stdout).decode("ascii")


def create_release(
    *,
    firmware_path: Path,
    source_path: Path,
    tag: str,
    private_key: Path,
    output_directory: Path,
    repository: str = DEFAULT_REPOSITORY,
) -> tuple[Path, Path]:
    version = source_version(source_path)
    if tag != f"v{version}":
        raise ValueError(
            f"release tag {tag!r} does not match firmware version v{version}"
        )
    if not firmware_path.is_file() or firmware_path.stat().st_size <= 0:
        raise ValueError(f"firmware binary is missing or empty: {firmware_path}")
    if not private_key.is_file():
        raise ValueError(f"OTA signing key is missing: {private_key}")

    firmware = firmware_path.read_bytes()
    size = len(firmware)
    md5 = hashlib.md5(firmware).hexdigest()  # nosec B303 - ESP Update API check
    sha256 = hashlib.sha256(firmware).hexdigest()
    signature = sign_payload(signed_payload(version, size, sha256), private_key)

    output_directory.mkdir(parents=True, exist_ok=True)
    binary_name = f"tramtrace-{version}.bin"
    binary_output = output_directory / binary_name
    shutil.copy2(firmware_path, binary_output)

    manifest = {
        "schema": 1,
        "product": "tramtrace-esp32",
        "version": version,
        "size": size,
        "md5": md5,
        "sha256": sha256,
        "signature_algorithm": "ecdsa-p256-sha256",
        "signing_key": "tramtrace-ota-2026-01",
        "signature": signature,
        "url": (
            f"https://github.com/{repository}/releases/download/"
            f"v{version}/{binary_name}"
        ),
    }
    manifest_output = output_directory / "manifest.json"
    manifest_output.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return binary_output, manifest_output


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a signed TramTrace OTA release manifest."
    )
    parser.add_argument("--firmware", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=Path("src/main.cpp"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--signing-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repository", default=DEFAULT_REPOSITORY)
    args = parser.parse_args()

    binary, manifest = create_release(
        firmware_path=args.firmware,
        source_path=args.source,
        tag=args.tag,
        private_key=args.signing_key,
        output_directory=args.output,
        repository=args.repository,
    )
    print(f"Created {binary}")
    print(f"Created {manifest}")


if __name__ == "__main__":
    main()
