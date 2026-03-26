from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any

import boto3
import httpx
from botocore.config import Config

from core.logger import get_logger

logger = get_logger("s3_streamer")


class AttachmentUnavailableError(Exception):
    """Raised when a remote URL returns a 4xx client-error response.

    This signals that the resource is not accessible (e.g. unauthorised or
    forbidden).  Callers can treat it as a skippable, non-fatal condition.
    """


_RETRYABLE_EXCEPTIONS = (
    httpx.RemoteProtocolError,
    httpx.ReadError,
    httpx.ConnectError,
    httpx.TimeoutException,
)
_MAX_RETRIES = 5
_RETRY_BACKOFF_BASE = 2.0  # seconds


def _get_s3_client() -> Any:
    endpoint = os.environ.get("AWS_ENDPOINT_URL")
    logger.debug("Creating S3 client", extra={"endpoint": endpoint})
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


async def stream_url_to_s3(
    url: str,
    headers: dict[str, str] | None = None,
    key_prefix: str = "imports",
) -> str:
    """Stream a remote URL directly to S3/MinIO using multipart upload.

    Returns the S3 object key.  Transient network errors (dropped connections,
    read timeouts, etc.) are retried up to ``_MAX_RETRIES`` times with
    exponential back-off.  On each retry, an HTTP ``Range`` header is sent so
    that only the missing bytes are re-downloaded, avoiding re-transferring
    already-uploaded data.  The same S3 multipart upload ID is reused across
    retries; the upload is only aborted if all retries are exhausted or a
    non-retryable error occurs.
    """
    bucket = os.environ.get("AWS_BUCKET_NAME", "lethe-imports")
    ext = url.split("?")[0].rsplit(".", 1)[-1][:10]
    key = f"{key_prefix}/{uuid.uuid4()}.{ext}"
    min_part_size = 5 * 1024 * 1024  # 5 MiB minimum for S3 multipart

    s3 = _get_s3_client()

    logger.debug(
        "Starting multipart upload",
        extra={"url": url, "bucket": bucket, "key": key},
    )
    mpu = s3.create_multipart_upload(Bucket=bucket, Key=key)
    upload_id: str = mpu["UploadId"]
    parts: list[dict[str, Any]] = []
    part_number = 1
    # Bytes already committed to S3 as completed parts.  Used as the resume
    # offset for Range requests on retry.
    committed_bytes = 0

    for attempt in range(_MAX_RETRIES + 1):
        if attempt > 0:
            delay = _RETRY_BACKOFF_BASE ** attempt
            logger.warning(
                "Resuming multipart upload after transient error",
                extra={
                    "url": url,
                    "key": key,
                    "attempt": attempt,
                    "delay": delay,
                    "committed_bytes": committed_bytes,
                },
            )
            await asyncio.sleep(delay)

        # Build request headers, adding a Range header when resuming.
        request_headers: dict[str, str] = dict(headers or {})
        if committed_bytes > 0:
            request_headers["Range"] = f"bytes={committed_bytes}-"

        buffer = bytearray()

        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
                async with client.stream("GET", url, headers=request_headers) as response:
                    logger.debug(
                        "HTTP response received",
                        extra={"url": url, "status_code": response.status_code},
                    )

                    if committed_bytes > 0 and response.status_code == 200:
                        # Server ignored the Range header and sent the full
                        # file from the start.  Abort the current upload and
                        # start a fresh one so we don't mix offsets.
                        logger.warning(
                            "Server returned 200 for Range request; restarting upload from scratch",
                            extra={"url": url, "key": key, "committed_bytes": committed_bytes},
                        )
                        try:
                            s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
                        except Exception:
                            logger.warning(
                                "Failed to abort multipart upload during restart",
                                extra={"key": key, "upload_id": upload_id},
                                exc_info=True,
                            )
                        mpu = s3.create_multipart_upload(Bucket=bucket, Key=key)
                        upload_id = mpu["UploadId"]
                        parts = []
                        part_number = 1
                        committed_bytes = 0

                    if 400 <= response.status_code < 500:
                        raise AttachmentUnavailableError(
                            f"HTTP {response.status_code} for url '{url}'"
                        )
                    response.raise_for_status()

                    async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):
                        buffer.extend(chunk)
                        if len(buffer) >= min_part_size:
                            logger.debug(
                                "Uploading part",
                                extra={"key": key, "part_number": part_number, "size": len(buffer)},
                            )
                            part = s3.upload_part(
                                Bucket=bucket,
                                Key=key,
                                PartNumber=part_number,
                                UploadId=upload_id,
                                Body=bytes(buffer),
                            )
                            parts.append({"PartNumber": part_number, "ETag": part["ETag"]})
                            part_number += 1
                            committed_bytes += len(buffer)
                            buffer.clear()

            if buffer:
                logger.debug(
                    "Uploading final part",
                    extra={"key": key, "part_number": part_number, "size": len(buffer)},
                )
                part = s3.upload_part(
                    Bucket=bucket,
                    Key=key,
                    PartNumber=part_number,
                    UploadId=upload_id,
                    Body=bytes(buffer),
                )
                parts.append({"PartNumber": part_number, "ETag": part["ETag"]})

            s3.complete_multipart_upload(
                Bucket=bucket,
                Key=key,
                UploadId=upload_id,
                MultipartUpload={"Parts": parts},
            )
            logger.info(
                "Multipart upload complete",
                extra={"key": key, "total_parts": len(parts), "bucket": bucket},
            )
            return key

        except _RETRYABLE_EXCEPTIONS as exc:
            logger.warning(
                "Multipart upload interrupted by transient error; will resume",
                extra={
                    "key": key,
                    "upload_id": upload_id,
                    "attempt": attempt,
                    "committed_bytes": committed_bytes,
                    "error": str(exc),
                },
                exc_info=True,
            )
            if attempt == _MAX_RETRIES:
                # All retries exhausted — clean up and propagate.
                try:
                    s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
                except Exception:
                    logger.warning(
                        "Failed to abort multipart upload after all retries",
                        extra={"key": key, "upload_id": upload_id},
                        exc_info=True,
                    )
                logger.error(
                    "Multipart upload failed after all retries",
                    extra={"key": key, "attempts": attempt + 1, "error": str(exc)},
                )
                raise

        except AttachmentUnavailableError:
            logger.debug(
                "Aborting multipart upload: URL returned client error",
                extra={"url": url, "key": key, "upload_id": upload_id},
            )
            try:
                s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
            except Exception:
                logger.debug(
                    "Failed to abort multipart upload for unavailable URL",
                    extra={"key": key, "upload_id": upload_id},
                    exc_info=True,
                )
            raise

        except Exception as exc:
            logger.error(
                "Multipart upload failed with non-retryable error, aborting",
                extra={"key": key, "upload_id": upload_id, "error": str(exc)},
                exc_info=True,
            )
            try:
                s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
            except Exception:
                logger.warning(
                    "Failed to abort multipart upload after non-retryable error",
                    extra={"key": key, "upload_id": upload_id},
                    exc_info=True,
                )
            raise

    # This line is unreachable: the loop always returns on success or raises on
    # the final retry, but is required to satisfy static type checkers.
    raise AssertionError("unreachable")
