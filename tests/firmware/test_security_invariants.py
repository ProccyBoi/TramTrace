from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "src" / "main.cpp").read_text(encoding="utf-8")


def test_https_clients_fail_closed_with_the_ca_bundle() -> None:
    assert "setInsecure" not in SOURCE
    assert SOURCE.count("configureSecureClient(") == 4
    assert "setCACertBundle" in SOURCE
    assert "_binary_x509_crt_bundle_start" in SOURCE


def test_board_access_key_is_a_header_not_a_url_parameter() -> None:
    payload_url = re.search(
        r"String payloadUrl\(\) \{(?P<body>.*?)\n\}", SOURCE, re.DOTALL
    )
    assert payload_url is not None
    assert "board_id" not in payload_url.group("body")
    assert 'http.addHeader("Authorization"' in SOURCE
    assert 'String(F("Bearer ")) + gConfig.boardKey' in SOURCE


def test_captive_portal_never_repopulates_saved_secrets() -> None:
    assert "htmlEscape(gConfig.password)" not in SOURCE
    assert "htmlEscape(gConfig.boardKey)" not in SOURCE
    assert "autocomplete='new-password'" in SOURCE
    assert "name='clear_board'" in SOURCE


def test_first_boot_checks_optional_nvs_keys_before_reading_them() -> None:
    for key in ("ssid", "pass", "api", "board"):
        assert f'gPreferences.isKey("{key}")' in SOURCE


def test_new_ota_image_uses_a_delayed_signed_manifest_checkpoint() -> None:
    assert 'extern "C" bool verifyRollbackLater() { return true; }' in SOURCE
    signature_check = SOURCE.index("verifyManifestSignature(", SOURCE.index("bool checkForOtaUpdate"))
    confirmation = SOURCE.index("confirmRunningOtaImage()", signature_check)
    version_decision = SOURCE.index("firmwareVersionIsNewer", confirmation)
    assert signature_check < confirmation < version_decision
    assert "esp_ota_mark_app_valid_cancel_rollback" in SOURCE


def test_tls_ota_has_explicit_loop_stack_headroom() -> None:
    match = re.search(r"SET_LOOP_TASK_STACK_SIZE\((\d+)\)", SOURCE)
    assert match is not None
    assert int(match.group(1)) >= 24 * 1024


def test_serial_access_key_rotation_preserves_the_loaded_configuration() -> None:
    assert 'if (verb == "access-key")' in SOURCE
    assert "gConfig.boardKey = accessKey;" in SOURCE
    assert "saveConfig(gConfig);" in SOURCE
    assert "access-key|new-key" in SOURCE


def test_live_payload_is_bounded_and_fully_decoded_before_json_parsing() -> None:
    assert "constexpr size_t kMaximumPayloadBytes" in SOURCE
    assert "BoundedStringStream payload(kMaximumPayloadBytes);" in SOURCE
    assert "http.writeToStream(&payload)" in SOURCE
    assert "deserializeJson(document, payload.data())" in SOURCE
    assert "deserializeJson(document, http.getStream())" not in SOURCE


def test_ota_manifest_and_binary_decode_http_framing_before_verification() -> None:
    assert "BoundedStringStream manifestPayload(kOtaManifestMaximumBytes);" in SOURCE
    assert "http.writeToStream(&manifestPayload)" in SOURCE
    assert "deserializeJson(manifest, manifestPayload.data())" in SOURCE
    assert "FirmwareUpdateStream firmwareStream" in SOURCE
    assert "http.writeToStream(&firmwareStream)" in SOURCE
    assert "http.getStreamPtr()" not in SOURCE
