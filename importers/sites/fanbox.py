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
    ScrapedPost,
)
from core.s3_streamer import stream_url_to_s3

_API_BASE = "https://api.fanbox.cc"
_ORIGIN = "https://www.fanbox.cc"

_RATE_LIMIT_INITIAL_DELAY = 60
_RATE_LIMIT_MAX_DELAY = 600
_RATE_LIMIT_MAX_RETRIES = 5
_POST_DELAY: float = float(os.environ.get("POST_DELAY_SECONDS", "1"))

_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"}
_AUDIO_EXTS = {".mp3", ".ogg", ".wav", ".flac", ".aac", ".m4a", ".opus"}


def _dtype(path: str) -> str:
    ext = ("." + path.rsplit(".", 1)[-1].lower()) if "." in path else ""
    if ext in _IMAGE_EXTS:
        return "IMAGE"
    if ext in _VIDEO_EXTS:
        return "VIDEO"
    if ext in _AUDIO_EXTS:
        return "AUDIO"
    return "FILE"


class FanboxScraper(BaseScraper):
    """Scrapes creator posts and media from Pixiv Fanbox (fanbox.cc).

    Token formats (one of):
    * ``https://www.fanbox.cc/@{creatorId}/posts`` — import specific creator.
    * ``@{creatorId}`` or ``{creatorId}`` — import specific creator by URL ID.
    * A raw ``FANBOXSESSID`` cookie value — scrape all posts from creators the
      authenticated user follows/supports.

    The ``external_id`` is set to the Fanbox post ID and ``service_type`` to
    ``"fanbox"`` so that records merge correctly with Kemono-sourced data.
    """

    @property
    def site_name(self) -> str:
        return "fanbox"

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _auth_headers(self, session_cookie: str | None = None) -> dict[str, str]:
        h: dict[str, str] = {
            "Origin": _ORIGIN,
            "Referer": _ORIGIN + "/",
            "Accept": "application/json, text/plain, */*",
        }
        if session_cookie:
            h["Cookie"] = f"FANBOXSESSID={session_cookie}"
        return h

    def _parse_token(self) -> tuple[str | None, str | None]:
        """Return ``(creator_id, session_cookie)``."""
        token = self.session_token.strip()

        url_m = re.search(r"fanbox\.cc/@?([a-zA-Z0-9_-]+)(?:/|$)", token, re.IGNORECASE)
        if url_m:
            return url_m.group(1).lstrip("@"), None

        # Short creator ID: alphanumeric, not too long, not a hex token
        cid = token.lstrip("@")
        if (
            re.match(r"^@?[a-zA-Z0-9_-]{1,50}$", token)
            and not re.match(r"^[0-9a-f]{32,}$", cid, re.IGNORECASE)
        ):
            return cid, None

        return None, token

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
                raise RuntimeError("rate limit reached on fanbox.cc")
            self.logger.warning(
                "Rate limited by Fanbox",
                extra={"job_id": self.job_id, "wait": delay, "attempt": attempt + 1},
            )
            if self.flush_callback:
                await self.flush_callback(
                    [], [], 0,
                    f"Rate limited — waiting {delay}s (attempt {attempt + 1})",
                )
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
        raise RuntimeError("rate limit reached on fanbox.cc")

    async def _creator_info(
        self,
        client: httpx.AsyncClient,
        creator_id: str,
        headers: dict[str, str],
    ) -> dict[str, Any]:
        resp = await self._get(client, f"{_API_BASE}/creator.get", headers, {"creatorId": creator_id})
        if resp.status_code == 404:
            raise ValueError(f"Fanbox creator not found: {creator_id!r}")
        resp.raise_for_status()
        return resp.json().get("body") or {}

    async def _creator_posts(
        self,
        client: httpx.AsyncClient,
        creator_id: str,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        posts: list[dict[str, Any]] = []
        next_url: str | None = (
            f"{_API_BASE}/post.listCreator?creatorId={creator_id}&limit=10"
        )
        while next_url:
            resp = await self._get(client, next_url, headers)
            resp.raise_for_status()
            body = resp.json().get("body") or {}
            items: list[dict[str, Any]] = body.get("items") or []
            posts.extend(items)
            next_url = body.get("nextUrl")
            if items:
                await asyncio.sleep(0.5)
        return posts

    async def _supporting_posts(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        posts: list[dict[str, Any]] = []
        offset = 0
        while True:
            resp = await self._get(
                client,
                f"{_API_BASE}/post.listSupporting",
                headers,
                {"limit": 10, "offset": offset},
            )
            if resp.status_code == 401:
                raise ValueError(
                    "Invalid Fanbox session cookie — please log in to fanbox.cc first."
                )
            resp.raise_for_status()
            items: list[dict[str, Any]] = resp.json().get("body", {}).get("items") or []
            if not items:
                break
            posts.extend(items)
            offset += 10
            await asyncio.sleep(0.5)
        return posts

    async def _post_detail(
        self,
        client: httpx.AsyncClient,
        post_id: str,
        headers: dict[str, str],
    ) -> dict[str, Any] | None:
        try:
            resp = await self._get(client, f"{_API_BASE}/post.info", headers, {"postId": post_id})
            if resp.status_code in (403, 404):
                return None
            resp.raise_for_status()
            return resp.json().get("body") or None
        except Exception as exc:
            self.logger.warning(
                "Could not fetch post detail",
                extra={"job_id": self.job_id, "post_id": post_id, "error": str(exc)},
            )
            return None

    async def _stream(self, url: str, headers: dict[str, str], name: str | None = None) -> ScrapedAttachment | None:
        try:
            s3_key = await stream_url_to_s3(url, headers, "fanbox")
            return ScrapedAttachment(file_url=s3_key, data_type=_dtype(name or url), name=name)
        except Exception as exc:
            self.logger.warning(
                "Failed to stream attachment",
                extra={"job_id": self.job_id, "url": url, "error": str(exc)},
            )
            return None

    # ------------------------------------------------------------------
    # Post content extraction
    # ------------------------------------------------------------------

    async def _extract_attachments(
        self,
        post_data: dict[str, Any],
        headers: dict[str, str],
    ) -> tuple[list[ScrapedAttachment], str]:
        """Return (attachments, content_html) from a fully-detailed post dict."""
        attachments: list[ScrapedAttachment] = []
        content_html = ""
        post_type = post_data.get("type") or ""
        body = post_data.get("body") or {}

        if post_type == "image":
            image_map: dict[str, Any] = body.get("imageMap") or {}
            for block in body.get("blocks") or []:
                btype = block.get("type")
                if btype == "image":
                    img_id = block.get("imageId") or ""
                    img_data = image_map.get(img_id, {})
                    url = img_data.get("originalUrl") or img_data.get("thumbnailUrl")
                    if url:
                        att = await self._stream(url, headers, f"{img_id}.jpg")
                        if att:
                            attachments.append(att)
                elif btype == "p":
                    text = block.get("text") or ""
                    if text:
                        content_html += f"<p>{text}</p>"

        elif post_type == "article":
            image_map = body.get("imageMap") or {}
            file_map: dict[str, Any] = body.get("fileMap") or {}
            for block in body.get("blocks") or []:
                btype = block.get("type")
                if btype == "p":
                    content_html += f"<p>{block.get('text') or ''}</p>"
                elif btype == "image":
                    img_id = block.get("imageId") or ""
                    img_data = image_map.get(img_id, {})
                    url = img_data.get("originalUrl") or img_data.get("thumbnailUrl")
                    if url:
                        att = await self._stream(url, headers, f"{img_id}.jpg")
                        if att:
                            attachments.append(att)
                elif btype == "file":
                    file_id = block.get("fileId") or ""
                    file_data = file_map.get(file_id, {})
                    url = file_data.get("url")
                    fname = file_data.get("name") or file_id
                    if url:
                        att = await self._stream(url, headers, fname)
                        if att:
                            attachments.append(att)

        elif post_type == "file":
            for f in body.get("files") or []:
                url = f.get("url")
                fname = f"{f.get('name') or ''}".strip(".")
                ext = f.get("extension") or "bin"
                full_name = f"{fname}.{ext}" if fname else f"file.{ext}"
                if url:
                    att = await self._stream(url, headers, full_name)
                    if att:
                        attachments.append(att)

        elif post_type == "video":
            embed = (body.get("serviceProvider") or {}).get("embedUrl")
            if embed:
                content_html += f'<p><a href="{embed}">[video]</a></p>'

        return attachments, content_html

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def scrape(self) -> ScrapeResult:
        creator_id, session_cookie = self._parse_token()
        headers = self._auth_headers(session_cookie)

        all_posts: list[ScrapedPost] = []
        flushed = 0

        async with httpx.AsyncClient(timeout=60) as client:
            creator_info: dict[str, Any] = {}
            if creator_id:
                self.logger.info(
                    "Fetching Fanbox creator",
                    extra={"job_id": self.job_id, "creator_id": creator_id},
                )
                creator_info = await self._creator_info(client, creator_id, headers)
                raw_posts = await self._creator_posts(client, creator_id, headers)
            else:
                self.logger.info("Fetching supporting posts", extra={"job_id": self.job_id})
                raw_posts = await self._supporting_posts(client, headers)

            if not raw_posts:
                return ScrapeResult(posts=[], items=[], progress_pct=100)

            total = len(raw_posts)
            self.logger.info("Processing Fanbox posts", extra={"job_id": self.job_id, "total": total})

            for idx, raw in enumerate(raw_posts):
                pid = str(raw.get("id") or "")
                if not pid:
                    continue

                detail = await self._post_detail(client, pid, headers)
                if detail:
                    raw = {**raw, **detail}

                user = raw.get("user") or creator_info.get("user") or {}
                creator_ext_id = str(
                    user.get("userId") or raw.get("creatorId") or ""
                )
                title = raw.get("title") or ""
                published_at = raw.get("publishedDatetime")
                creator_name = user.get("name") or creator_info.get("user", {}).get("name")
                thumb = user.get("iconUrl") or creator_info.get("user", {}).get("iconUrl")

                attachments, content_html = await self._extract_attachments(raw, headers)

                post = ScrapedPost(
                    external_id=pid,
                    creator_external_id=creator_ext_id,
                    service_type="fanbox",
                    title=title,
                    content=content_html or None,
                    published_at=published_at,
                    attachments=attachments,
                    creator_name=creator_name,
                    creator_thumbnail_url=thumb,
                )
                all_posts.append(post)

                progress = int((idx + 1) / total * 100)
                if self.flush_callback and (idx + 1) % 5 == 0:
                    await self.flush_callback(
                        all_posts[flushed:], [], progress,
                        f"Processed {idx + 1}/{total} Fanbox posts",
                    )
                    flushed = len(all_posts)

                await asyncio.sleep(_POST_DELAY)

        return ScrapeResult(posts=all_posts[flushed:], items=[], progress_pct=100)
