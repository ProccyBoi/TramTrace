from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

import pytest

from scripts.create_ota_release import create_release, signed_payload


def generate_signing_key(directory: Path) -> tuple[Path, Path]:
    private_key = directory / "private.pem"
    public_key = directory / "public.pem"
    subprocess.run(
        [
            "openssl",
            "ecparam",
            "-name",
            "prime256v1",
            "-genkey",
            "-noout",
            "-out",
            str(private_key),
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            "openssl",
            "ec",
            "-in",
            str(private_key),
            "-pubout",
            "-out",
            str(public_key),
        ],
        check=True,
        capture_output=True,
    )
    return private_key, public_key


def test_release_manifest_is_signed_and_bound_to_the_binary(tmp_path: Path) -> None:
    source = tmp_path / "main.cpp"
    source.write_text(
        'constexpr char kFirmwareVersion[] = "0.3.0";\n', encoding="utf-8"
    )
    firmware = tmp_path / "firmware.bin"
    firmware.write_bytes(b"signed TramTrace firmware")
    private_key, public_key = generate_signing_key(tmp_path)

    binary, manifest_path = create_release(
        firmware_path=firmware,
        source_path=source,
        tag="v0.3.0",
        private_key=private_key,
        output_directory=tmp_path / "release",
    )

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert binary.read_bytes() == firmware.read_bytes()
    assert manifest["version"] == "0.3.0"
    assert manifest["size"] == len(firmware.read_bytes())
    assert manifest["url"].endswith("/v0.3.0/tramtrace-0.3.0.bin")

    signature = tmp_path / "signature.der"
    signature.write_bytes(base64.b64decode(manifest["signature"], validate=True))
    subprocess.run(
        [
            "openssl",
            "dgst",
            "-sha256",
            "-verify",
            str(public_key),
            "-signature",
            str(signature),
        ],
        input=signed_payload(
            manifest["version"], manifest["size"], manifest["sha256"]
        ),
        check=True,
        capture_output=True,
    )


def test_release_tag_must_match_the_compiled_version(tmp_path: Path) -> None:
    source = tmp_path / "main.cpp"
    source.write_text(
        'constexpr char kFirmwareVersion[] = "0.3.0";\n', encoding="utf-8"
    )
    firmware = tmp_path / "firmware.bin"
    firmware.write_bytes(b"firmware")
    private_key, _ = generate_signing_key(tmp_path)

    with pytest.raises(ValueError, match="does not match"):
        create_release(
            firmware_path=firmware,
            source_path=source,
            tag="v0.3.1",
            private_key=private_key,
            output_directory=tmp_path / "release",
        )
