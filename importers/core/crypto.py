from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from core.logger import get_logger

logger = get_logger("crypto")

IV_LENGTH = 16
TAG_LENGTH = 16  # GCM auth tag is appended by AESGCM automatically


def _get_key() -> bytes:
    key_str = os.environ.get("ENCRYPTION_KEY")
    if not key_str:
        raise RuntimeError("ENCRYPTION_KEY environment variable is not set")
    key = key_str.encode("utf-8")
    if len(key) != 32:
        raise RuntimeError("ENCRYPTION_KEY must be exactly 32 bytes (UTF-8)")
    return key


def decrypt_token(ciphertext_b64: str) -> str:
    """Decrypt a token that was encrypted by the Node.js backend using AES-256-GCM."""
    logger.debug("Decrypting token")
    key = _get_key()
    data = base64.b64decode(ciphertext_b64)
    iv = data[:IV_LENGTH]
    # Node.js crypto appends the auth tag separately; layout is: iv(16) | tag(16) | ciphertext
    tag = data[IV_LENGTH : IV_LENGTH + TAG_LENGTH]
    ciphertext = data[IV_LENGTH + TAG_LENGTH :]
    # AESGCM expects ciphertext + tag appended
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv, ciphertext + tag, None)
    logger.debug("Token decrypted successfully")
    return plaintext.decode("utf-8")
