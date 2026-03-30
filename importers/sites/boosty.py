from __future__ import annotations

import asyncio
import os
import re
from datetime import datetime, timezone
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

_API_BASE = "https://api.boosty.to/v1"

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


def _blocks_to_html(content_blocks: list[dict[str, Any]]) -> str:
    """Convert Boosty content block array to simple HTML."""
    parts: list[str] = []
    for block in content_blocks:
        btype = block.get("type") or ""
        if btype in ("text", "paragraph"):
            text = block.get("content") or block.get("text") or ""
            if isinstance(text, list):
                # Inline runs
                text = "".join(
                    run.get("content") or run.get("text") or ""
                    for run in text
                    if isinstance(run, dict)
                )
            if text:
                parts.append(f"<p>{text}</p>")
        elif btype == "link":
            url = block.get("url") or block.get("content") or ""
            if url:
                parts.append(f'<p><a href="{url}">{url}</a></p>')
    return "".join(parts)


class BoostyScraper(BaseScraper):
    """Scrapes posts and media from Boosty (boosty.to).

    Token formats (one of):
    * ``https://boosty.to/{blog_name}`` or ``{blog_name}`` — public/authenticated
      import of a specific creator's blog (access token optional).
    * ``{blog_name}:{access_token}`` — import a specific blog with auth.
    * ``{access_token}`` (long JWT string) — import all followed blogs.

    The Boosty ``access_token`` is a JWT Bearer token visible in the browser's
    network requests as the ``Authorization: Bearer ...`` header.

    ``external_id`` is the Boosty post ID, ``service_type`` is ``"boosty"``
    to match Kemono records.
    """

    @property
    def site_name(self) -> str:
        return "boosty"

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _parse_token(self) -> tuple[str | None, str | None]:
        """Return ``(blog_name, access_token)``."""
        token = self.session_token.strip()

        # Full URL: https://boosty.to/blogname
        url_m = re.match(r"^https?://boosty\.to/([^/?#\s]+)", token, re.IGNORECASE)
        if url_m:
            return url_m.group(1), None

        # blog_name:access_token
        if ":" in token and not token.startswith("eyJ"):
            parts = token.split(":", 1)
            blog = parts[0]
            access = parts[1] or None
            return blog, access

        # Plain alphanumeric blog name (not a JWT)
        if re.match(r"^[a-zA-Z0-9_.-]{1,50}$", token) and not token.startswith("eyJ"):
            return token, None

        # Treat as bare access token (JWT usually starts with eyJ)
        return None, token

    def _base_headers(self, access_token: str | None = None) -> dict[str, str]:
        h: dict[str, str] = {
            "Accept": "application/json",
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
        }
        if access_token:
            h["Authorization"] = f"Bearer {access_token}"
        return h

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
                raise RuntimeError("rate limit reached on boosty.to")
            self.logger.warning(
                "Rate limited by Boosty",
                extra={"job_id": self.job_id, "wait": delay},
            )
            if self.flush_callback:
                await self.flush_callback([], [], 0, f"Rate limited — waiting {delay}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
        raise RuntimeError("rate limit reached on boosty.to")

    async def _fetch_blog_info(
        self,
        client: httpx.AsyncClient,
        blog: str,
        headers: dict[str, str],
    ) -> dict[str, Any]:
        resp = await self._get(client, f"{_API_BASE}/blog/{blog}", headers)
        if resp.status_code == 404:
            raise ValueError(f"Boosty blog not found: {blog!r}")
        resp.raise_for_status()
        return resp.json()

    async def _fetch_blog_posts(
        self,
        client: httpx.AsyncClient,
        blog: str,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        posts: list[dict[str, Any]] = []
        offset = 0
        limit = 10
        while True:
            resp = await self._get(
                client,
                f"{_API_BASE}/blog/{blog}/post",
                headers,
                {
                    "limit": limit,
                    "offset": offset,
                    "sort_by": "publish_time",
                    "order": "gt",
                    "only_allowed": "true",
                },
            )
            if resp.status_code in (403, 404):
                break
            resp.raise_for_status()
            data = resp.json()
            items: list[dict[str, Any]] = data.get("data") or []
            if not items:
                break
            posts.extend(items)
            extra = data.get("extra") or {}
            if extra.get("isLast", True):
                break
            offset += limit
            await asyncio.sleep(0.5)
        return posts

    async def _fetch_followed_blogs(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
    ) -> list[str]:
        resp = await self._get(
            client,
            f"{_API_BASE}/user/subscriptions",
            headers,
            {"limit": 100},
        )
        if resp.status_code == 401:
            raise ValueError("Invalid Boosty access token — please log in first.")
        if resp.status_code != 200:
            return []
        data = resp.json()
        blogs = data.get("data") or data if isinstance(data, list) else []
        return [b.get("blogUrl") or b.get("blog") or str(b.get("id") or "") for b in blogs if b.get("blogUrl") or b.get("blog")]

    async def _stream(self, url: str, headers: dict[str, str], name: str | None = None) -> ScrapedAttachment | None:
        try:
            s3_key = await stream_url_to_s3(url, headers, "boosty")
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
        blog_name, access_token = self._parse_token()
        headers = self._base_headers(access_token)

        all_posts: list[ScrapedPost] = []
        flushed = 0

        async with httpx.AsyncClient(timeout=60) as client:
            if blog_name:
                blogs = [blog_name]
            else:
                self.logger.info("Fetching Boosty followed blogs", extra={"job_id": self.job_id})
                blogs = await self._fetch_followed_blogs(client, headers)
                self.logger.info(
                    "Found followed blogs",
                    extra={"job_id": self.job_id, "count": len(blogs)},
                )

            for b_idx, blog in enumerate(blogs):
                self.logger.info(
                    "Fetching Boosty blog posts",
                    extra={"job_id": self.job_id, "blog": blog},
                )
                try:
                    blog_info = await self._fetch_blog_info(client, blog, headers)
                except Exception as exc:
                    self.logger.warning(
                        "Could not fetch blog info",
                        extra={"job_id": self.job_id, "blog": blog, "error": str(exc)},
                    )
                    blog_info = {}

                creator_name = (
                    blog_info.get("name")
                    or blog_info.get("title")
                    or blog
                )
                creator_ext_id = str(
                    blog_info.get("id") or blog_info.get("userId") or blog
                )
                thumbnail_url = blog_info.get("avatarUrl")

                raw_posts = await self._fetch_blog_posts(client, blog, headers)
                total = len(raw_posts)
                n_blogs = max(len(blogs), 1)

                for idx, raw in enumerate(raw_posts):
                    pid = str(raw.get("id") or "")
                    if not pid:
                        continue

                    try:
                        title = raw.get("title") or raw.get("name") or ""
                        published_ts = raw.get("publishTime") or raw.get("publishedAt")
                        published_at: str | None = None
                        if published_ts and isinstance(published_ts, (int, float)):
                            published_at = datetime.fromtimestamp(
                                published_ts, tz=timezone.utc
                            ).isoformat()
                        elif isinstance(published_ts, str):
                            published_at = published_ts

                        content_blocks = raw.get("data") or raw.get("content") or []
                        content_html = ""
                        if isinstance(content_blocks, list):
                            content_html = _blocks_to_html(content_blocks)
                        elif isinstance(content_blocks, str):
                            content_html = content_blocks

                        attachments: list[ScrapedAttachment] = []
                        for media in raw.get("media") or []:
                            url = (
                                media.get("url")
                                or media.get("full_url")
                                or media.get("playerUrl")
                            )
                            if url:
                                att = await self._stream(url, headers, media.get("filename"))
                                if att:
                                    media_type = media.get("type") or ""
                                    if "video" in media_type.lower():
                                        att.data_type = "VIDEO"
                                    elif "audio" in media_type.lower():
                                        att.data_type = "AUDIO"
                                    elif "image" in media_type.lower() or "photo" in media_type.lower():
                                        att.data_type = "IMAGE"
                                    attachments.append(att)

                        # Comments
                        comments: list[ScrapedComment] = []
                        for c in raw.get("comments") or []:
                            ci = str(c.get("id") or "")
                            if ci:
                                comments.append(
                                    ScrapedComment(
                                        external_id=ci,
                                        content=c.get("message") or c.get("content") or "",
                                        author_name=(c.get("user") or {}).get("name"),
                                        published_at=c.get("createdAt"),
                                    )
                                )

                        post = ScrapedPost(
                            external_id=pid,
                            creator_external_id=creator_ext_id,
                            service_type="boosty",
                            title=title or None,
                            content=content_html or None,
                            published_at=published_at,
                            attachments=attachments,
                            comments=comments,
                            creator_name=creator_name or None,
                            creator_thumbnail_url=thumbnail_url,
                        )
                        all_posts.append(post)
                    except Exception as exc:
                        self.logger.warning(
                            "Failed to process Boosty post — skipping",
                            extra={"job_id": self.job_id, "post_id": pid, "blog": blog, "error": str(exc)},
                        )
                        continue

                    overall_progress = int(
                        (b_idx / n_blogs + (idx + 1) / (total * n_blogs)) * 100
                    )
                    if self.flush_callback and (idx + 1) % 5 == 0:
                        await self.flush_callback(
                            all_posts[flushed:], [], overall_progress,
                            f"Blog {b_idx + 1}/{len(blogs)}: processed {idx + 1}/{total} posts",
                        )
                        flushed = len(all_posts)

                    await asyncio.sleep(_POST_DELAY)

        return ScrapeResult(posts=all_posts[flushed:], items=[], progress_pct=100)
