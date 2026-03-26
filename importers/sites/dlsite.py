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

_API_BASE = "https://www.dlsite.com"
_INFO_API = "https://www.dlsite.com/home/api/=/product/info.json"

_RATE_LIMIT_INITIAL_DELAY = 60
_RATE_LIMIT_MAX_DELAY = 600
_RATE_LIMIT_MAX_RETRIES = 5
_POST_DELAY: float = float(os.environ.get("POST_DELAY_SECONDS", "1"))

# DLsite work number pattern (RJ, BJ, VJ, RE, …)
_WORK_ID_RE = re.compile(r"^(?:[RBVrce][Jje]?\d{6,8}|D[Ll]\d{6,8})$", re.IGNORECASE)

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


class DLsiteScraper(BaseScraper):
    """Scrapes work metadata and sample images from DLsite.

    Token formats (one of):
    * A DLsite work ID such as ``RJ123456`` or a full product URL — import
      metadata for that specific work.
    * A ``_loginkey`` session cookie — import all works from the authenticated
      user's library (purchase history).

    ``external_id`` is the DLsite work number (e.g. ``RJ123456``),
    ``service_type`` is ``"dlsite"`` to match Kemono records.
    """

    @property
    def site_name(self) -> str:
        return "dlsite"

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _parse_token(self) -> tuple[str | None, str | None]:
        """Return ``(work_id, session_cookie)``."""
        token = self.session_token.strip()

        # Full URL: https://www.dlsite.com/maniax/work/=/product_id/RJ123456.html
        url_m = re.search(r"/product_id/([A-Z]{2}\d{6,8})", token, re.IGNORECASE)
        if url_m:
            return url_m.group(1).upper(), None

        # Bare work ID
        if _WORK_ID_RE.match(token):
            return token.upper(), None

        # Session cookie
        return None, token

    def _base_headers(self, session_cookie: str | None = None) -> dict[str, str]:
        h: dict[str, str] = {
            "Accept": "application/json, text/html, */*",
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
        }
        if session_cookie:
            h["Cookie"] = f"_loginkey={session_cookie}"
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
                raise RuntimeError("rate limit reached on dlsite.com")
            self.logger.warning(
                "Rate limited by DLsite",
                extra={"job_id": self.job_id, "wait": delay},
            )
            if self.flush_callback:
                await self.flush_callback([], [], 0, f"Rate limited — waiting {delay}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
        raise RuntimeError("rate limit reached on dlsite.com")

    async def _fetch_work_info(
        self,
        client: httpx.AsyncClient,
        work_id: str,
        headers: dict[str, str],
    ) -> dict[str, Any] | None:
        resp = await self._get(
            client, _INFO_API, headers, {"workno": work_id}
        )
        if resp.status_code in (404, 400):
            return None
        resp.raise_for_status()
        data = resp.json()
        # Response is a dict keyed by work_id
        return data.get(work_id) or list(data.values())[0] if data else None

    async def _fetch_library_page(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
        page: int = 1,
    ) -> tuple[list[str], bool]:
        """Return ``(work_ids, has_more)`` for a single library page."""
        resp = await self._get(
            client,
            f"{_API_BASE}/home/library/me/ajax/dlsite-purchase-list",
            headers,
            {"page": page},
        )
        if resp.status_code in (401, 302, 403):
            raise ValueError(
                "Invalid DLsite session cookie — please log in to dlsite.com first."
            )
        if resp.status_code != 200:
            return [], False
        try:
            data = resp.json()
        except Exception:
            return [], False
        works: list[str] = [
            str(w.get("workno") or w.get("product_id") or "")
            for w in (data.get("works") or data.get("items") or [])
        ]
        works = [w for w in works if w]
        has_more = bool(data.get("has_next") or data.get("next_page"))
        return works, has_more

    async def _stream(self, url: str, headers: dict[str, str], name: str | None = None) -> ScrapedAttachment | None:
        try:
            s3_key = await stream_url_to_s3(url, headers, "dlsite")
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
        work_id, session_cookie = self._parse_token()
        headers = self._base_headers(session_cookie)

        all_posts: list[ScrapedPost] = []
        flushed = 0

        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            if work_id:
                work_ids = [work_id]
            else:
                self.logger.info("Fetching DLsite library", extra={"job_id": self.job_id})
                work_ids = []
                page = 1
                while True:
                    ids, has_more = await self._fetch_library_page(client, headers, page)
                    work_ids.extend(ids)
                    if not has_more or not ids:
                        break
                    page += 1
                    await asyncio.sleep(0.5)
                self.logger.info(
                    "DLsite library fetched",
                    extra={"job_id": self.job_id, "count": len(work_ids)},
                )

            if not work_ids:
                return ScrapeResult(posts=[], items=[], progress_pct=100)

            total = len(work_ids)
            for idx, wid in enumerate(work_ids):
                self.logger.debug(
                    "Fetching DLsite work info",
                    extra={"job_id": self.job_id, "work_id": wid},
                )
                info = await self._fetch_work_info(client, wid, headers)
                if info is None:
                    continue

                maker = info.get("maker_name") or info.get("circle") or ""
                maker_id = str(
                    info.get("maker_id") or info.get("circle_id") or maker or ""
                )
                title = info.get("work_name") or info.get("title") or wid
                # DLsite doesn't have "posts", so treat each work as a post
                content_parts: list[str] = []
                if info.get("intro_s"):
                    content_parts.append(f"<p>{info['intro_s']}</p>")
                published_at = info.get("regist_date") or info.get("dl_date")

                attachments: list[ScrapedAttachment] = []

                # Main cover image
                image_main = info.get("image_main")
                img_url = image_main.get("url") if isinstance(image_main, dict) else image_main
                if img_url:
                    if img_url.startswith("//"):
                        img_url = "https:" + img_url
                    att = await self._stream(img_url, headers, "cover.jpg")
                    if att:
                        att.data_type = "IMAGE"
                        attachments.append(att)

                # Sample images
                for sample in info.get("sample_images") or []:
                    s_url = sample.get("thumb") or sample.get("url")
                    if s_url:
                        if s_url.startswith("//"):
                            s_url = "https:" + s_url
                        att = await self._stream(s_url, headers)
                        if att:
                            att.data_type = "IMAGE"
                            attachments.append(att)

                post = ScrapedPost(
                    external_id=wid,
                    creator_external_id=maker_id,
                    service_type="dlsite",
                    title=title,
                    content="".join(content_parts) or None,
                    published_at=published_at,
                    attachments=attachments,
                    creator_name=maker or None,
                )
                all_posts.append(post)

                progress = int((idx + 1) / total * 100)
                if self.flush_callback and (idx + 1) % 5 == 0:
                    await self.flush_callback(
                        all_posts[flushed:], [], progress,
                        f"Processed {idx + 1}/{total} DLsite works",
                    )
                    flushed = len(all_posts)

                await asyncio.sleep(_POST_DELAY)

        return ScrapeResult(posts=all_posts[flushed:], items=[], progress_pct=100)
