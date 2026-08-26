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
