from __future__ import annotations

import asyncio
import hashlib
import os
import re
import time
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

_API_BASE = "https://onlyfans.com/api2/v2"
_RULES_URL = "https://onlyfans.com/api2/v2/init"

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


class OnlyFansScraper(BaseScraper):
    """Scrapes posts and media from OnlyFans.

    Token format:
    * ``{sess_cookie}:{user_id}`` — authenticated user, all active subscriptions.
    * ``{sess_cookie}:{user_id}:{creator_id}`` — specific creator.

    The ``sess_cookie`` is the value of the ``sess`` cookie, and ``user_id`` is
    the numeric OnlyFans user ID (visible in the website's network requests).

    ``external_id`` is the post ID, ``service_type`` is ``"onlyfans"`` to
    match Kemono records.

    .. note::
        OnlyFans requires a per-request HMAC signature.  The sign parameters
        (static_param, prefix, suffix) are fetched once from the ``/init``
        endpoint on startup.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._static_param: str = ""
        self._prefix: str = ""
        self._suffix: str = ""
        self._app_token: str = ""

    @property
    def site_name(self) -> str:
        return "onlyfans"

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _parse_token(self) -> tuple[str, str, str | None]:
        """Return ``(sess_cookie, user_id, creator_id_or_None)``."""
        token = self.session_token.strip()
        parts = token.split(":")
        if len(parts) >= 2:
            sess = parts[0]
            user_id = parts[1]
            creator_id = parts[2] if len(parts) >= 3 else None
            return sess, user_id, creator_id
        raise ValueError(
            "OnlyFans token must be in format 'sess_cookie:user_id' "
            "or 'sess_cookie:user_id:creator_id'"
        )

    def _sign(self, path: str) -> dict[str, str]:
        """Return the request headers containing the sign for *path*."""
        ts = str(int(time.time() * 1000))
        sha1_input = "\n".join([self._static_param, ts, path, ""])
        sha1 = hashlib.sha1(sha1_input.encode()).hexdigest()
        sign = ":".join(filter(None, [self._prefix, sha1, ts, self._suffix]))
        return {"sign": sign, "time": ts, "app-token": self._app_token}

    def _base_headers(self, sess: str, user_id: str) -> dict[str, str]:
        return {
            "Accept": "application/json, text/plain, */*",
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            "Cookie": f"sess={sess}",
            "user-id": user_id,
        }

    async def _fetch_rules(self, client: httpx.AsyncClient, base_headers: dict[str, str]) -> None:
        """Fetch dynamic sign parameters from the /init endpoint."""
        try:
            resp = await client.get(_RULES_URL, headers=base_headers, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            self._static_param = data.get("static_param", "")
            self._prefix = data.get("prefix", "")
            self._suffix = data.get("suffix", "")
            self._app_token = data.get("app_token", "")
        except Exception as exc:
            self.logger.warning(
                "Failed to fetch OnlyFans dynamic rules; requests may fail",
                extra={"job_id": self.job_id, "error": str(exc)},
            )

    async def _get(
        self,
        client: httpx.AsyncClient,
        path: str,
        base_headers: dict[str, str],
        params: dict[str, Any] | None = None,
    ) -> httpx.Response:
        url = f"{_API_BASE}{path}"
        sign_headers = self._sign(path)
        headers = {**base_headers, **sign_headers}
        delay = _RATE_LIMIT_INITIAL_DELAY
        for attempt in range(_RATE_LIMIT_MAX_RETRIES + 1):
            resp = await client.get(url, params=params, headers=headers)
            if resp.status_code not in (429, 503):
                return resp
            if attempt == _RATE_LIMIT_MAX_RETRIES:
                raise RuntimeError("rate limit reached on onlyfans.com")
            self.logger.warning(
                "Rate limited by OnlyFans",
                extra={"job_id": self.job_id, "wait": delay},
            )
            if self.flush_callback:
                await self.flush_callback([], [], 0, f"Rate limited — waiting {delay}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
            # Refresh sign with new timestamp
            sign_headers = self._sign(path)
            headers = {**base_headers, **sign_headers}
        raise RuntimeError("rate limit reached on onlyfans.com")

    async def _get_subscriptions(
        self,
        client: httpx.AsyncClient,
        base_headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        path = "/subscriptions/subscribes"
        subs: list[dict[str, Any]] = []
        offset = 0
        limit = 20
        while True:
            resp = await self._get(
                client, path, base_headers,
                {"type": "active", "limit": limit, "offset": offset},
            )
            if resp.status_code == 401:
                raise ValueError("Invalid OnlyFans session — please check your sess cookie.")
            resp.raise_for_status()
            data = resp.json()
            items = data if isinstance(data, list) else data.get("list") or []
            if not items:
                break
            subs.extend(items)
            if len(items) < limit:
                break
            offset += limit
            await asyncio.sleep(0.5)
        return subs

    async def _get_creator_posts(
        self,
        client: httpx.AsyncClient,
        creator_id: str,
        base_headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        path = f"/users/{creator_id}/posts"
        posts: list[dict[str, Any]] = []
        before_publish_time: str = ""
        limit = 20
        while True:
            params: dict[str, Any] = {"limit": limit, "order": "publish_date_desc"}
            if before_publish_time:
                params["beforePublishTime"] = before_publish_time
            resp = await self._get(client, path, base_headers, params)
            if resp.status_code in (403, 404):
                break
            resp.raise_for_status()
            raw_json = resp.json()
            data: list[dict[str, Any]] = raw_json if isinstance(raw_json, list) else raw_json.get("list") or []
            if not data:
                break
            posts.extend(data)
            if len(data) < limit:
                break
            # Paginate using the oldest post's publishedAt
            last = data[-1]
            before_publish_time = str(last.get("postedAt") or last.get("publishedAt") or "")
            if not before_publish_time:
                break
            await asyncio.sleep(0.5)
        return posts

    async def _stream(self, url: str, headers: dict[str, str], name: str | None = None) -> ScrapedAttachment | None:
        try:
            s3_key = await stream_url_to_s3(url, headers, "onlyfans")
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
        sess, user_id, creator_id = self._parse_token()
        base_headers = self._base_headers(sess, user_id)

        all_posts: list[ScrapedPost] = []
        flushed = 0

        async with httpx.AsyncClient(timeout=60) as client:
            await self._fetch_rules(client, base_headers)

            # Determine which creator(s) to scrape
            if creator_id:
                creator_ids = [creator_id]
            else:
                self.logger.info("Fetching OnlyFans subscriptions", extra={"job_id": self.job_id})
                subs = await self._get_subscriptions(client, base_headers)
                creator_ids = [str(s.get("id") or "") for s in subs if s.get("id")]
                self.logger.info(
                    "Found subscriptions",
                    extra={"job_id": self.job_id, "count": len(creator_ids)},
                )

            for c_idx, cid in enumerate(creator_ids):
                self.logger.info(
                    "Fetching OnlyFans creator posts",
                    extra={"job_id": self.job_id, "creator_id": cid},
                )
                raw_posts = await self._get_creator_posts(client, cid, base_headers)
                total = len(raw_posts)

                for idx, raw in enumerate(raw_posts):
                    pid = str(raw.get("id") or "")
                    if not pid:
                        continue

                    author = raw.get("author") or {}
                    c_name = author.get("name") or author.get("username") or ""
                    c_ext_id = str(author.get("id") or cid)
                    title = raw.get("title") or ""
                    content = raw.get("text") or ""
                    published_at = raw.get("postedAt") or raw.get("publishedAt")

                    attachments: list[ScrapedAttachment] = []
                    for media in raw.get("media") or []:
                        src = media.get("full") or media.get("preview") or media.get("src")
                        media_type = media.get("type") or ""
                        if src:
                            att = await self._stream(src, base_headers)
                            if att:
                                if "video" in media_type.lower():
                                    att.data_type = "VIDEO"
                                elif "audio" in media_type.lower():
                                    att.data_type = "AUDIO"
                                elif "photo" in media_type.lower() or "image" in media_type.lower():
                                    att.data_type = "IMAGE"
                                attachments.append(att)

                    comments: list[ScrapedComment] = []
                    for c in raw.get("comments") or []:
                        ci = str(c.get("id") or "")
                        if ci:
                            comments.append(
                                ScrapedComment(
                                    external_id=ci,
                                    content=c.get("text") or "",
                                    author_name=(c.get("author") or {}).get("name"),
                                    published_at=c.get("createdAt"),
                                )
                            )

                    post = ScrapedPost(
                        external_id=pid,
                        creator_external_id=c_ext_id,
                        service_type="onlyfans",
                        title=title,
                        content=content or None,
                        published_at=published_at,
                        attachments=attachments,
                        comments=comments,
                        creator_name=c_name or None,
                    )
                    all_posts.append(post)

                    overall_progress = int(
                        (c_idx / len(creator_ids) + (idx + 1) / (total * len(creator_ids))) * 100
                    )
                    if self.flush_callback and (idx + 1) % 5 == 0:
                        await self.flush_callback(
                            all_posts[flushed:], [], overall_progress,
                            f"Creator {c_idx + 1}/{len(creator_ids)}: "
                            f"processed {idx + 1}/{total} posts",
                        )
                        flushed = len(all_posts)

                    await asyncio.sleep(_POST_DELAY)

        return ScrapeResult(posts=all_posts[flushed:], items=[], progress_pct=100)
