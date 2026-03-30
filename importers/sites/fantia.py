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

_API_BASE = "https://fantia.jp/api/v1"
_WEB_BASE = "https://fantia.jp"

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


class FantiaScraper(BaseScraper):
    """Scrapes posts and media from Fantia (fantia.jp).

    Token formats (one of):
    * ``https://fantia.jp/fanclubs/{id}`` or ``{fanclub_id}`` — import a
      specific fanclub.
    * A raw ``_session_id`` cookie value — import all posts from fanclubs the
      authenticated user has joined.

    ``external_id`` is the Fantia post ID, ``creator_external_id`` is the
    fanclub ID, and ``service_type`` is ``"fantia"`` to match Kemono records.
    """

    @property
    def site_name(self) -> str:
        return "fantia"

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _parse_token(self) -> tuple[str | None, str | None]:
        """Return ``(fanclub_id, session_cookie)``."""
        token = self.session_token.strip()

        # Full URL: https://fantia.jp/fanclubs/12345
        url_m = re.match(r"^https?://fantia\.jp/fanclubs/(\d+)", token, re.IGNORECASE)
        if url_m:
            return url_m.group(1), None

        # Pure numeric ID
        if re.match(r"^\d{1,12}$", token):
            return token, None

        return None, token

    def _base_headers(self, session_cookie: str | None = None) -> dict[str, str]:
        h: dict[str, str] = {
            "Accept": "application/json",
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            "Referer": _WEB_BASE + "/",
        }
        if session_cookie:
            h["Cookie"] = f"_session_id={session_cookie}"
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
                raise RuntimeError("rate limit reached on fantia.jp")
            self.logger.warning(
                "Rate limited by Fantia",
                extra={"job_id": self.job_id, "wait": delay},
            )
            if self.flush_callback:
                await self.flush_callback([], [], 0, f"Rate limited — waiting {delay}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
        raise RuntimeError("rate limit reached on fantia.jp")

    async def _fetch_fanclub_info(
        self,
        client: httpx.AsyncClient,
        fanclub_id: str,
        headers: dict[str, str],
    ) -> dict[str, Any]:
        resp = await self._get(client, f"{_API_BASE}/fanclubs/{fanclub_id}", headers)
        if resp.status_code == 404:
            raise ValueError(f"Fantia fanclub not found: {fanclub_id!r}")
        resp.raise_for_status()
        return resp.json().get("fanclub") or {}

    async def _fetch_followed_fanclubs(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
    ) -> list[str]:
        """Return fanclub IDs for all fanclubs the session user has joined."""
        resp = await self._get(
            client,
            f"{_API_BASE}/me/fanclubs/followings",
            headers,
        )
        if resp.status_code == 401:
            raise ValueError(
                "Invalid Fantia session cookie — please log in to fantia.jp first."
            )
        if resp.status_code != 200:
            return []
        data = resp.json()
        fanclubs = data.get("fanclubs") or []
        return [str(fc.get("id") or "") for fc in fanclubs if fc.get("id")]

    async def _fetch_fanclub_post_ids(
        self,
        client: httpx.AsyncClient,
        fanclub_id: str,
        headers: dict[str, str],
    ) -> list[str]:
        post_ids: list[str] = []
        page = 1
        while True:
            resp = await self._get(
                client,
                f"{_API_BASE}/fanclubs/{fanclub_id}/posts",
                headers,
                {"page": page},
            )
            if resp.status_code in (403, 404):
                break
            resp.raise_for_status()
            data = resp.json()
            posts = data.get("posts") or []
            if not posts:
                break
            post_ids.extend(str(p.get("id") or "") for p in posts if p.get("id"))
            pagination = data.get("pagination") or {}
            total_pages = int(pagination.get("total") or 1)
            if page >= total_pages:
                break
            page += 1
            await asyncio.sleep(0.5)
        return [pid for pid in post_ids if pid]

    async def _fetch_post_detail(
        self,
        client: httpx.AsyncClient,
        post_id: str,
        headers: dict[str, str],
    ) -> dict[str, Any] | None:
        try:
            resp = await self._get(client, f"{_API_BASE}/posts/{post_id}", headers)
            if resp.status_code in (403, 404):
                return None
            resp.raise_for_status()
            return resp.json().get("post") or {}
        except Exception as exc:
            self.logger.warning(
                "Could not fetch Fantia post detail",
                extra={"job_id": self.job_id, "post_id": post_id, "error": str(exc)},
            )
            return None

    async def _stream(self, url: str, headers: dict[str, str], name: str | None = None) -> ScrapedAttachment | None:
        try:
            # Fantia serves media from cdn.fantia.jp — prepend base if relative
            if url.startswith("/"):
                url = _WEB_BASE + url
            s3_key = await stream_url_to_s3(url, headers, "fantia")
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
        fanclub_id, session_cookie = self._parse_token()
        headers = self._base_headers(session_cookie)

        all_posts: list[ScrapedPost] = []
        flushed = 0

        async with httpx.AsyncClient(timeout=60) as client:
            if fanclub_id:
                fanclub_ids = [fanclub_id]
            else:
                self.logger.info("Fetching Fantia followed fanclubs", extra={"job_id": self.job_id})
                fanclub_ids = await self._fetch_followed_fanclubs(client, headers)
                self.logger.info(
                    "Found followed fanclubs",
                    extra={"job_id": self.job_id, "count": len(fanclub_ids)},
                )

            for fc_idx, fcid in enumerate(fanclub_ids):
                self.logger.info(
                    "Fetching Fantia fanclub",
                    extra={"job_id": self.job_id, "fanclub_id": fcid},
                )
                try:
                    fanclub_info = await self._fetch_fanclub_info(client, fcid, headers)
                except Exception as exc:
                    self.logger.warning(
                        "Could not fetch fanclub info",
                        extra={"job_id": self.job_id, "fanclub_id": fcid, "error": str(exc)},
                    )
                    fanclub_info = {}

                creator_name = fanclub_info.get("fanclub_name_or_creator_name") or fanclub_info.get("name") or ""
                creator = fanclub_info.get("creator") or {}
                creator_name = creator_name or creator.get("name") or ""
                thumbnail_url = fanclub_info.get("icon") or fanclub_info.get("image") or None
                banner_url = fanclub_info.get("cover") or None

                post_ids = await self._fetch_fanclub_post_ids(client, fcid, headers)
                total = len(post_ids)
                n_fanclubs = max(len(fanclub_ids), 1)
                self.logger.info(
                    "Found fanclub posts",
                    extra={"job_id": self.job_id, "fanclub_id": fcid, "count": total},
                )

                for idx, pid in enumerate(post_ids):
                    try:
                        detail = await self._fetch_post_detail(client, pid, headers)
                        if not detail:
                            continue

                        title = detail.get("title") or ""
                        content_raw = detail.get("comment") or detail.get("body") or ""
                        published_at = detail.get("posted_at")

                        attachments: list[ScrapedAttachment] = []
                        for pc in detail.get("post_contents") or []:
                            # Photos inside a post content block
                            for photo in pc.get("post_content_photos") or []:
                                url = photo.get("url") or photo.get("original_url")
                                if url:
                                    att = await self._stream(url, headers)
                                    if att:
                                        att.data_type = "IMAGE"
                                        attachments.append(att)
                            # File download link
                            file_url = pc.get("download_uri") or pc.get("file_url") or pc.get("attachment_uri")
                            if file_url:
                                att = await self._stream(file_url, headers, pc.get("filename"))
                                if att:
                                    attachments.append(att)

                        # Comments
                        comments: list[ScrapedComment] = []
                        for c in detail.get("comments") or []:
                            ci = str(c.get("id") or "")
                            if ci:
                                comments.append(
                                    ScrapedComment(
                                        external_id=ci,
                                        content=c.get("comment") or c.get("body") or "",
                                        author_name=(c.get("member") or c.get("user") or {}).get("name"),
                                        published_at=c.get("created_at"),
                                    )
                                )

                        post = ScrapedPost(
                            external_id=pid,
                            creator_external_id=fcid,
                            service_type="fantia",
                            title=title or None,
                            content=content_raw or None,
                            published_at=published_at,
                            attachments=attachments,
                            comments=comments,
                            creator_name=creator_name or None,
                            creator_thumbnail_url=thumbnail_url,
                            creator_banner_url=banner_url,
                        )
                        all_posts.append(post)
                    except Exception as exc:
                        self.logger.warning(
                            "Failed to process Fantia post — skipping",
                            extra={"job_id": self.job_id, "post_id": pid, "fanclub_id": fcid, "error": str(exc)},
                        )
                        continue

                    overall_progress = int(
                        (fc_idx / n_fanclubs + (idx + 1) / (total * n_fanclubs)) * 100
                    )
                    if self.flush_callback and (idx + 1) % 5 == 0:
                        await self.flush_callback(
                            all_posts[flushed:], [], overall_progress,
                            f"Fanclub {fc_idx + 1}/{len(fanclub_ids)}: "
                            f"processed {idx + 1}/{total} posts",
                        )
                        flushed = len(all_posts)

                    await asyncio.sleep(_POST_DELAY)

        return ScrapeResult(posts=all_posts[flushed:], items=[], progress_pct=100)
