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

# SubscribeStar operates on two domains
_DOMAINS = ["https://www.subscribestar.com", "https://www.subscribestar.adult"]

_RATE_LIMIT_INITIAL_DELAY = 60
_RATE_LIMIT_MAX_DELAY = 600
_RATE_LIMIT_MAX_RETRIES = 5
_POST_DELAY: float = float(os.environ.get("POST_DELAY_SECONDS", "1"))

_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv"}
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


class SubscribeStarScraper(BaseScraper):
    """Scrapes posts from SubscribeStar (subscribestar.com / subscribestar.adult).

    Token formats (one of):
    * ``https://www.subscribestar.com/{creator}`` or
      ``https://www.subscribestar.adult/{creator}`` — import specific creator.
    * ``{creator}`` — import a creator by their username (tries .com first, then .adult).
    * A raw ``_session_id`` cookie value — import all posts from subscribed/followed creators.

    ``external_id`` is the post ID, ``service_type`` is ``"subscribestar"`` to
    match Kemono records.
    """

    @property
    def site_name(self) -> str:
        return "subscribestar"

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _base_headers(self, session_cookie: str | None = None) -> dict[str, str]:
        h: dict[str, str] = {
            "Accept": "application/json, text/html, */*",
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            "X-Requested-With": "XMLHttpRequest",
        }
        if session_cookie:
            h["Cookie"] = f"_session_id={session_cookie}"
        return h

    def _parse_token(self) -> tuple[str | None, str | None, str]:
        """Return ``(creator_username, session_cookie, base_url)``."""
        token = self.session_token.strip()

        # Full URL
        m = re.match(
            r"^https?://(?:www\.)?(subscribestar\.(?:com|adult))/([^/?#\s]+)",
            token,
            re.IGNORECASE,
        )
        if m:
            base = f"https://www.{m.group(1)}"
            return m.group(2), None, base

        # Simple creator name
        if (
            re.match(r"^[a-zA-Z0-9_-]{1,60}$", token)
            and not re.match(r"^[0-9a-f]{32,}$", token, re.IGNORECASE)
        ):
            return token, None, _DOMAINS[0]

        return None, token, _DOMAINS[0]

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
                raise RuntimeError("rate limit reached on subscribestar")
            self.logger.warning(
                "Rate limited by SubscribeStar",
                extra={"job_id": self.job_id, "wait": delay},
            )
            if self.flush_callback:
                await self.flush_callback([], [], 0, f"Rate limited — waiting {delay}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
        raise RuntimeError("rate limit reached on subscribestar")

    async def _fetch_creator_posts(
        self,
        client: httpx.AsyncClient,
        base_url: str,
        creator: str,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        """Paginate through a creator's posts via the internal AJAX API."""
        posts: list[dict[str, Any]] = []
        page = 1
        while True:
            resp = await self._get(
                client,
                f"{base_url}/{creator}",
                headers,
                {"page": page},
            )
            if resp.status_code == 404:
                # Try the adult domain if .com didn't work
                if ".com" in base_url:
                    resp = await self._get(
                        client,
                        f"{_DOMAINS[1]}/{creator}",
                        headers,
                        {"page": page},
                    )
                if resp.status_code == 404:
                    self.logger.warning(
                        "Creator not found on SubscribeStar",
                        extra={"job_id": self.job_id, "creator": creator},
                    )
                    break
            if resp.status_code != 200:
                break

            try:
                data = resp.json()
            except Exception:
                break

            items: list[dict[str, Any]] = data.get("posts") or []
            if not items:
                break
            posts.extend(items)
            if not data.get("has_more", False) and not data.get("next_page"):
                break
            page += 1
            await asyncio.sleep(0.5)

        return posts

    async def _fetch_subscriptions_posts(
        self,
        client: httpx.AsyncClient,
        base_url: str,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        """Fetch posts from all subscribed creators."""
        posts: list[dict[str, Any]] = []
        page = 1
        while True:
            resp = await self._get(
                client,
                f"{base_url}/feed",
                headers,
                {"page": page},
            )
            if resp.status_code in (401, 302):
                raise ValueError(
                    "Invalid SubscribeStar session — please log in first."
                )
            if resp.status_code != 200:
                break
            try:
                data = resp.json()
            except Exception:
                break
            items: list[dict[str, Any]] = data.get("posts") or []
            if not items:
                break
            posts.extend(items)
            if not data.get("has_more", False):
                break
            page += 1
            await asyncio.sleep(0.5)
        return posts

    async def _stream(self, url: str, headers: dict[str, str], name: str | None = None) -> ScrapedAttachment | None:
        try:
            s3_key = await stream_url_to_s3(url, headers, "subscribestar")
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
        creator, session_cookie, base_url = self._parse_token()
        headers = self._base_headers(session_cookie)

        all_posts: list[ScrapedPost] = []
        flushed = 0

        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            if creator:
                self.logger.info(
                    "Fetching SubscribeStar creator posts",
                    extra={"job_id": self.job_id, "creator": creator},
                )
                raw_posts = await self._fetch_creator_posts(client, base_url, creator, headers)
            else:
                self.logger.info(
                    "Fetching SubscribeStar subscription feed",
                    extra={"job_id": self.job_id},
                )
                raw_posts = await self._fetch_subscriptions_posts(client, base_url, headers)

            if not raw_posts:
                return ScrapeResult(posts=[], items=[], progress_pct=100)

            total = len(raw_posts)
            self.logger.info(
                "Processing SubscribeStar posts",
                extra={"job_id": self.job_id, "total": total},
            )

            for idx, raw in enumerate(raw_posts):
                pid = str(raw.get("id") or "")
                if not pid:
                    continue

                try:
                    star = raw.get("star") or {}
                    creator_name = star.get("name") or raw.get("star_name") or ""
                    creator_ext_id = str(star.get("id") or star.get("star_id") or creator or "")
                    title = raw.get("title") or ""
                    content = raw.get("html") or raw.get("content") or ""
                    published_at = raw.get("created_at") or raw.get("published_at")

                    attachments: list[ScrapedAttachment] = []
                    # Media attached to the post
                    for media in raw.get("media") or []:
                        url = media.get("url") or media.get("full_url") or media.get("preview")
                        if url:
                            att = await self._stream(url, headers, media.get("filename"))
                            if att:
                                att.data_type = _dtype(media.get("type") or url)
                                attachments.append(att)

                    # Comments
                    comments: list[ScrapedComment] = []
                    for c in raw.get("comments") or []:
                        cid = str(c.get("id") or "")
                        if cid:
                            comments.append(
                                ScrapedComment(
                                    external_id=cid,
                                    content=c.get("body") or c.get("content") or "",
                                    author_name=c.get("user", {}).get("name"),
                                    published_at=c.get("created_at"),
                                )
                            )

                    post = ScrapedPost(
                        external_id=pid,
                        creator_external_id=creator_ext_id,
                        service_type="subscribestar",
                        title=title,
                        content=content or None,
                        published_at=published_at,
                        attachments=attachments,
                        comments=comments,
                        creator_name=creator_name or None,
                    )
                    all_posts.append(post)
                except Exception as exc:
                    self.logger.warning(
                        "Failed to process SubscribeStar post — skipping",
                        extra={"job_id": self.job_id, "post_id": pid, "error": str(exc)},
                    )
                    continue

                progress = int((idx + 1) / total * 100)
                if self.flush_callback and (idx + 1) % 5 == 0:
                    await self.flush_callback(
                        all_posts[flushed:], [], progress,
                        f"Processed {idx + 1}/{total} SubscribeStar posts",
                    )
                    flushed = len(all_posts)

                await asyncio.sleep(_POST_DELAY)

        return ScrapeResult(posts=all_posts[flushed:], items=[], progress_pct=100)
