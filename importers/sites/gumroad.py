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

_WEB_BASE = "https://gumroad.com"
_API_BASE = "https://api.gumroad.com/v2"

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


class GumroadScraper(BaseScraper):
    """Scrapes products and purchases from Gumroad.

    Token formats (one of):
    * ``https://gumroad.com/{creator}`` or ``https://{creator}.gumroad.com`` —
      import all public products for a specific creator.
    * ``{creator}`` — import public products for a creator by username.
    * A Gumroad ``_gumroad_app_session`` cookie value — import the authenticated
      user's purchased library.

    ``external_id`` is the Gumroad product permalink/ID, ``service_type`` is
    ``"gumroad"`` to match Kemono records.
    """

    @property
    def site_name(self) -> str:
        return "gumroad"

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
        }
        if session_cookie:
            h["Cookie"] = f"_gumroad_app_session={session_cookie}"
        return h

    def _parse_token(self) -> tuple[str | None, str | None]:
        """Return ``(creator_username, session_cookie)``."""
        token = self.session_token.strip()

        # Full URL: https://gumroad.com/creator or https://creator.gumroad.com
        m = re.search(r"(?:^https?://(?:([^.]+)\.)?gumroad\.com(?:/([^/?#\s]+))?)", token, re.IGNORECASE)
        if m:
            # subdomain form: creator.gumroad.com
            if m.group(1) and m.group(1).lower() not in ("www", "app"):
                return m.group(1).lower(), None
            # path form: gumroad.com/creator
            if m.group(2) and m.group(2) not in ("l",):
                return m.group(2).lower(), None

        # Simple username: alphanumeric, not a long hex session token
        if (
            re.match(r"^[a-zA-Z0-9_-]{1,50}$", token)
            and not re.match(r"^[0-9a-f]{32,}$", token, re.IGNORECASE)
        ):
            return token.lower(), None

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
                raise RuntimeError("rate limit reached on gumroad.com")
            wait = delay
            self.logger.warning(
                "Rate limited by Gumroad",
                extra={"job_id": self.job_id, "wait": wait, "attempt": attempt + 1},
            )
            if self.flush_callback:
                await self.flush_callback(
                    [], [], 0,
                    f"Rate limited — waiting {wait}s (attempt {attempt + 1})",
                )
            await asyncio.sleep(wait)
            delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
        raise RuntimeError("rate limit reached on gumroad.com")

    async def _fetch_creator_products(
        self,
        client: httpx.AsyncClient,
        creator: str,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        """Fetch public products for a creator using the Gumroad discover endpoint."""
        products: list[dict[str, Any]] = []
        page = 1
        while True:
            resp = await self._get(
                client,
                f"{_WEB_BASE}/{creator}",
                headers,
                {"page": page, "format": "json"},
            )
            if resp.status_code == 404:
                self.logger.warning(
                    "Creator not found",
                    extra={"job_id": self.job_id, "creator": creator},
                )
                break
            if resp.status_code != 200:
                break
            try:
                data = resp.json()
                items: list[dict[str, Any]] = data.get("products") or []
            except Exception:
                # Some endpoints return HTML — no more pages
                break
            if not items:
                break
            products.extend(items)
            if not data.get("next_page_url"):
                break
            page += 1
            await asyncio.sleep(0.5)
        return products

    async def _fetch_library(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        """Fetch the authenticated user's purchased library."""
        products: list[dict[str, Any]] = []
        page = 1
        while True:
            resp = await self._get(
                client,
                f"{_WEB_BASE}/library",
                headers,
                {"page": page, "format": "json"},
            )
            if resp.status_code == 401 or resp.status_code == 302:
                raise ValueError(
                    "Invalid Gumroad session cookie — please log in to gumroad.com first."
                )
            if resp.status_code != 200:
                break
            try:
                data = resp.json()
                items: list[dict[str, Any]] = (
                    data.get("products")
                    or data.get("sale_products")
                    or []
                )
            except Exception:
                break
            if not items:
                break
            products.extend(items)
            if not data.get("next_page_url"):
                break
            page += 1
            await asyncio.sleep(0.5)
        return products

    async def _stream(
        self,
        url: str,
        headers: dict[str, str],
        name: str | None = None,
    ) -> ScrapedAttachment | None:
        try:
            s3_key = await stream_url_to_s3(url, headers, "gumroad")
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
        creator, session_cookie = self._parse_token()
        headers = self._base_headers(session_cookie)

        all_posts: list[ScrapedPost] = []
        flushed = 0

        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            if creator:
                self.logger.info(
                    "Fetching Gumroad creator products",
                    extra={"job_id": self.job_id, "creator": creator},
                )
                raw_products = await self._fetch_creator_products(client, creator, headers)
            else:
                self.logger.info("Fetching Gumroad library", extra={"job_id": self.job_id})
                raw_products = await self._fetch_library(client, headers)

            if not raw_products:
                return ScrapeResult(posts=[], items=[], progress_pct=100)

            total = len(raw_products)
            self.logger.info(
                "Processing Gumroad products",
                extra={"job_id": self.job_id, "total": total},
            )

            for idx, product in enumerate(raw_products):
                # Gumroad product permalink is the canonical ID
                pid = str(
                    product.get("id")
                    or product.get("url_slug")
                    or product.get("short_url")
                    or product.get("permalink")
                    or ""
                )
                if not pid:
                    continue

                creator_name = (
                    product.get("creator_name")
                    or (product.get("seller") or {}).get("name")
                    or creator
                    or ""
                )
                creator_ext_id = str(
                    (product.get("seller") or {}).get("id") or creator or ""
                )
                title = product.get("name") or product.get("product_name") or ""
                description = product.get("description") or product.get("long_description") or ""
                published_at = (
                    product.get("published_at")
                    or product.get("created_at")
                )
                thumbnail_url = product.get("thumbnail_url")

                attachments: list[ScrapedAttachment] = []

                # Stream thumbnail if present
                if thumbnail_url:
                    att = await self._stream(thumbnail_url, headers, "thumbnail.jpg")
                    if att:
                        att.data_type = "IMAGE"
                        attachments.append(att)

                # Stream any preview files
                preview_url = product.get("preview_url")
                for preview in ([preview_url] if preview_url else []):
                    att = await self._stream(preview, headers)
                    if att:
                        attachments.append(att)

                post = ScrapedPost(
                    external_id=pid,
                    creator_external_id=creator_ext_id,
                    service_type="gumroad",
                    title=title,
                    content=f"<p>{description}</p>" if description else None,
                    published_at=published_at,
                    attachments=attachments,
                    creator_name=creator_name or None,
                    creator_thumbnail_url=None,
                )
                all_posts.append(post)

                progress = int((idx + 1) / total * 100)
                if self.flush_callback and (idx + 1) % 5 == 0:
                    await self.flush_callback(
                        all_posts[flushed:], [], progress,
                        f"Processed {idx + 1}/{total} Gumroad products",
                    )
                    flushed = len(all_posts)

                await asyncio.sleep(_POST_DELAY)

        return ScrapeResult(posts=all_posts[flushed:], items=[], progress_pct=100)
