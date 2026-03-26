from __future__ import annotations

import asyncio
import os
import re
from typing import Any

import httpx

from core.base_scraper import (
    BaseScraper,
    ScrapeResult,
    ScrapedAttachment,
    ScrapedComment,
    ScrapedPost,
)
from core.s3_streamer import stream_url_to_s3

_API_BASE = "https://apiv3.fansly.com/api/v1"

_RATE_LIMIT_INITIAL_DELAY = 60
_RATE_LIMIT_MAX_DELAY = 600
_RATE_LIMIT_MAX_RETRIES = 5
_POST_DELAY: float = float(os.environ.get("POST_DELAY_SECONDS", "1"))

_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"}
_AUDIO_EXTS = {".mp3", ".ogg", ".wav", ".flac", ".aac", ".m4a"}


def _dtype(path: str) -> str:
    ext = ("." + path.rsplit(".", 1)[-1].lower()) if "." in path else ""
    if ext in _IMAGE_EXTS:
        return "IMAGE"
    if ext in _VIDEO_EXTS:
        return "VIDEO"
    if ext in _AUDIO_EXTS:
        return "AUDIO"
    return "FILE"


class FanslyScraper(BaseScraper):
    """Scrapes posts and media from Fansly (fansly.com).

    Token formats (one of):
    * ``{auth_token}`` — import posts from all active subscriptions.
    * ``{auth_token}:{creator_username_or_id}`` — import a specific creator.

    The ``auth_token`` is the Bearer token from the Fansly API (visible in
    browser network requests as the ``Authorization`` header value).

    ``external_id`` is the Fansly post ID (snowflake), ``service_type`` is
    ``"fansly"`` to match Kemono records.
    """

    @property
    def site_name(self) -> str:
        return "fansly"

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _parse_token(self) -> tuple[str, str | None]:
        """Return ``(auth_token, creator_id_or_None)``."""
        token = self.session_token.strip()
        if ":" in token:
            parts = token.split(":", 1)
            return parts[0], parts[1]
        return token, None

    def _base_headers(self, auth_token: str) -> dict[str, str]:
        return {
            "Authorization": auth_token,
            "Accept": "application/json, text/plain, */*",
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
        }

    async def _get(
        self,
        client: httpx.AsyncClient,
        url: str,
        headers: dict[str, str],
        params: dict[str, Any] | None = None,
    ) -> httpx.Response:
        delay = _RATE_LIMIT_INITIAL_DELAY
        for attempt in range(_RATE_LIMIT_MAX_RETRIES + 1):
            resp = await client.get(url, params=params, headers=headers)
            if resp.status_code != 429:
                return resp
            if attempt == _RATE_LIMIT_MAX_RETRIES:
                raise RuntimeError("rate limit reached on fansly.com")
            self.logger.warning(
                "Rate limited by Fansly",
                extra={"job_id": self.job_id, "wait": delay},
            )
            if self.flush_callback:
                await self.flush_callback([], [], 0, f"Rate limited — waiting {delay}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
        raise RuntimeError("rate limit reached on fansly.com")

    async def _resolve_creator(
        self,
        client: httpx.AsyncClient,
        username_or_id: str,
        headers: dict[str, str],
    ) -> dict[str, Any] | None:
        """Look up a creator by username or ID and return their account data."""
        # Try username lookup
        resp = await self._get(
            client,
            f"{_API_BASE}/account",
            headers,
            {"usernames": username_or_id, "ngsw-bypass": "true"},
        )
        if resp.status_code == 200:
            data = resp.json()
            accounts = (data.get("response") or {}).get("accounts") or []
            if accounts:
                return accounts[0]
        # Might already be an ID
        return {"id": username_or_id}

    async def _get_subscriptions(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        resp = await self._get(
            client,
            f"{_API_BASE}/subscriptions",
            headers,
            {"status": 3, "ngsw-bypass": "true"},
        )
        if resp.status_code == 401:
            raise ValueError("Invalid Fansly auth token — please check your credentials.")
        resp.raise_for_status()
        data = resp.json()
        return (data.get("response") or {}).get("subscriptions") or []

    async def _get_creator_timeline(
        self,
        client: httpx.AsyncClient,
        creator_id: str,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        posts: list[dict[str, Any]] = []
        before = 0
        limit = 10
        while True:
            resp = await self._get(
                client,
                f"{_API_BASE}/timeline/{creator_id}",
                headers,
                {"before": before, "after": 0, "limit": limit, "ngsw-bypass": "true"},
            )
            if resp.status_code in (403, 404):
                break
            resp.raise_for_status()
            data = resp.json()
            posts_data = (data.get("response") or {}).get("posts") or []
            if not posts_data:
                break
            posts.extend(posts_data)
            if len(posts_data) < limit:
                break
            # Before is the smallest ID seen
            last_id = min(int(p.get("id", 0)) for p in posts_data if p.get("id"))
            if last_id == 0 or last_id == before:
                break
            before = last_id
            await asyncio.sleep(0.5)
        return posts

    async def _get_media_bundles(
        self,
        client: httpx.AsyncClient,
        bundle_ids: list[str],
        headers: dict[str, str],
    ) -> dict[str, Any]:
        """Resolve media bundle IDs to actual download URLs."""
        if not bundle_ids:
            return {}
        resp = await self._get(
            client,
            f"{_API_BASE}/account/media/bundle",
            headers,
            {"ids": ",".join(bundle_ids), "ngsw-bypass": "true"},
        )
        if resp.status_code != 200:
            return {}
        data = resp.json()
        bundles = (data.get("response") or {}).get("accountMediaBundles") or []
        result: dict[str, Any] = {}
        for b in bundles:
            result[str(b.get("id"))] = b
        return result

    async def _stream(self, url: str, headers: dict[str, str], name: str | None = None) -> ScrapedAttachment | None:
        try:
            s3_key = await stream_url_to_s3(url, headers, "fansly")
            return ScrapedAttachment(file_url=s3_key, data_type=_dtype(name or url), name=name)
        except Exception as exc:
            self.logger.warning(
                "Failed to stream attachment",
                extra={"job_id": self.job_id, "url": url, "error": str(exc)},
            )
            return None

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def scrape(self) -> ScrapeResult:
        auth_token, creator_target = self._parse_token()
        headers = self._base_headers(auth_token)

        all_posts: list[ScrapedPost] = []
        flushed = 0

        async with httpx.AsyncClient(timeout=60) as client:
            if creator_target:
                creator_data = await self._resolve_creator(client, creator_target, headers)
                creator_ids = [str(creator_data.get("id") or creator_target)]
                creator_names = {creator_ids[0]: creator_data.get("displayName") or creator_target}
            else:
                self.logger.info("Fetching Fansly subscriptions", extra={"job_id": self.job_id})
                subs = await self._get_subscriptions(client, headers)
                creator_ids = [str(s.get("subscriptionTierId") or s.get("accountId") or "") for s in subs]
                creator_ids = [c for c in creator_ids if c]
                creator_names: dict[str, str] = {}
                self.logger.info(
                    "Found Fansly subscriptions",
                    extra={"job_id": self.job_id, "count": len(creator_ids)},
                )

            for c_idx, cid in enumerate(creator_ids):
                self.logger.info(
                    "Fetching Fansly creator timeline",
                    extra={"job_id": self.job_id, "creator_id": cid},
                )
                raw_posts = await self._get_creator_timeline(client, cid, headers)
                total = len(raw_posts)
                n_creators = max(len(creator_ids), 1)

                for idx, raw in enumerate(raw_posts):
                    pid = str(raw.get("id") or "")
                    if not pid:
                        continue

                    c_name = creator_names.get(cid, "")
                    content = raw.get("content") or raw.get("text") or ""
                    published_at = raw.get("createdAt") or raw.get("publishedAt")

                    attachments: list[ScrapedAttachment] = []

                    # Inline media items
                    for media in raw.get("attachments") or raw.get("media") or []:
                        media_type = media.get("contentType") or media.get("type") or ""
                        src = (
                            media.get("location")
                            or (media.get("variants") or [{}])[0].get("location")
                            or media.get("url")
                            or ""
                        )
                        if src:
                            att = await self._stream(src, headers)
                            if att:
                                if "video" in media_type.lower():
                                    att.data_type = "VIDEO"
                                elif "audio" in media_type.lower():
                                    att.data_type = "AUDIO"
                                else:
                                    att.data_type = "IMAGE"
                                attachments.append(att)

                    post = ScrapedPost(
                        external_id=pid,
                        creator_external_id=cid,
                        service_type="fansly",
                        title=None,
                        content=content or None,
                        published_at=published_at,
                        attachments=attachments,
                        creator_name=c_name or None,
                    )
                    all_posts.append(post)

                    overall_progress = int(
                        (c_idx / n_creators + (idx + 1) / (total * n_creators)) * 100
                    )
                    if self.flush_callback and (idx + 1) % 5 == 0:
                        await self.flush_callback(
                            all_posts[flushed:], [], overall_progress,
                            f"Creator {c_idx + 1}/{len(creator_ids)}: "
                            f"processed {idx + 1}/{total} Fansly posts",
                        )
                        flushed = len(all_posts)

                    await asyncio.sleep(_POST_DELAY)

        return ScrapeResult(posts=all_posts[flushed:], items=[], progress_pct=100)
