from __future__ import annotations

import asyncio
import html
import json
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

BASE_URL = "https://www.patreon.com"
# Patreon's standard post-list page size.
PAGE_SIZE = 12

# Rate-limit back-off parameters (mirrors kemono.py).
_RATE_LIMIT_INITIAL_DELAY = 60
_RATE_LIMIT_MAX_DELAY = 600
_RATE_LIMIT_MAX_RETRIES = 5

_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v", ".wmv"}
_AUDIO_EXTS = {".mp3", ".ogg", ".wav", ".flac", ".aac", ".m4a", ".opus"}


def _data_type_for_media(media_type: str, file_name: str) -> str:
    """Infer Lethe DataType from Patreon media_type + file extension."""
    media_type = (media_type or "").lower()
    if media_type == "image":
        return "IMAGE"
    if media_type in ("video", "video_embed"):
        return "VIDEO"
    if media_type == "audio":
        return "AUDIO"
    # Fall back to extension-based detection.
    ext = ("." + file_name.rsplit(".", 1)[-1].lower()) if "." in file_name else ""
    if ext in _IMAGE_EXTS:
        return "IMAGE"
    if ext in _VIDEO_EXTS:
        return "VIDEO"
    if ext in _AUDIO_EXTS:
        return "AUDIO"
    return "FILE"


def _build_included_map(included: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Build a ``{type:id -> object}`` lookup from a JSON:API ``included`` list."""
    return {f"{obj.get('type', '')}:{obj.get('id', '')}": obj for obj in included}


class PatreonScraper(BaseScraper):
    """Scrapes creator posts and media directly from Patreon (patreon.com).

    Uses Patreon's internal JSON API (the same endpoints used by the official
    web client and the *patreon-dl* library).

    Token format — one of:

    * ``session:{session_id}`` — explicit session-cookie mode: imports all
      posts from creators the authenticated user is actively supporting.
    * ``session:{session_id}|creator:{url_or_vanity}`` — session-cookie mode
      with a specific creator filter; imports only that creator's posts using
      the authenticated session.
    * A Patreon creator URL — ``https://www.patreon.com/{creator}/posts``
      (or ``/c/{creator}/posts`` variant).  Imports that creator's *public*
      posts (no authentication).
    * ``{creator_vanity}`` — the creator's short name / vanity slug, e.g.
      ``johndoe``.  Imports that creator's public posts (no authentication).
    * A raw Patreon session-cookie string — imports all posts from creators
      the authenticated user is actively supporting (patron memberships).
      Prefer the explicit ``session:{session_id}`` format to avoid ambiguity
      with short vanity slugs.

    When the same Patreon creator is also imported via the Kemono scraper
    (``service_type="patreon"``), the posts are automatically **merged** in the
    database because both scrapers produce the same ``serviceType`` and
    ``externalId`` values, which is the key used for Creator/Post dedup.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._last_flush_progress: int = 0

    @property
    def site_name(self) -> str:
        return "patreon"

    # ------------------------------------------------------------------
    # Token parsing
    # ------------------------------------------------------------------

    def _parse_token(self) -> tuple[str | None, dict[str, str]]:
        """Return ``(vanity_or_none, http_headers)``.

        * Explicit ``session:{cookie}`` → ``(None, {"cookie": cookie})``
        * Explicit ``session:{cookie}|creator:{url_or_vanity}``
          → ``(vanity, {"cookie": cookie})``
        * Creator URL / vanity → ``(vanity, {})``
        * Session cookie (anything else) → ``(None, {"cookie": token})``
        """
        token = self.session_token.strip()

        # Explicit session-cookie format produced by the import UI:
        #   "session:{cookie_value}"
        #   "session:{cookie_value}|creator:{vanity_or_url}"
        if token.startswith("session:"):
            remainder = token[len("session:"):]
            creator_raw: str | None = None
            if "|creator:" in remainder:
                cookie_raw, creator_raw = remainder.split("|creator:", 1)
            else:
                cookie_raw = remainder
            cookie_val = cookie_raw.strip()
            if creator_raw is not None:
                creator_str = creator_raw.strip()
                # Extract vanity from a full Patreon URL if one was pasted.
                url_m = re.search(
                    r"patreon\.com/(?:c/)?([A-Za-z0-9_-]+)(?:/posts)?",
                    creator_str,
                    re.IGNORECASE,
                )
                vanity = url_m.group(1) if url_m else creator_str
                self.logger.debug(
                    "Token parsed as explicit session cookie with creator filter",
                    extra={"job_id": self.job_id, "vanity": vanity},
                )
                return vanity, {"cookie": cookie_val}
            self.logger.debug(
                "Token parsed as explicit session cookie",
                extra={"job_id": self.job_id},
            )
            return None, {"cookie": cookie_val}

        # Full Patreon creator URL patterns:
        #   https://www.patreon.com/{creator}/posts
        #   https://www.patreon.com/c/{creator}/posts
        url_match = re.search(
            r"patreon\.com/(?:c/)?([A-Za-z0-9_-]+)/posts",
            token,
            re.IGNORECASE,
        )
        if url_match:
            vanity = url_match.group(1)
            self.logger.debug(
                "Token parsed as Patreon creator URL",
                extra={"job_id": self.job_id, "vanity": vanity},
            )
            return vanity, {}

        # Short creator vanity: alphanumeric + underscore/hyphen, 2-50 chars.
        if re.match(r"^[A-Za-z0-9_-]{2,50}$", token):
            self.logger.debug(
                "Token parsed as creator vanity",
                extra={"job_id": self.job_id, "vanity": token},
            )
            return token, {}

        # Anything else is treated as a session cookie.
        self.logger.debug("Token parsed as session cookie", extra={"job_id": self.job_id})
        return None, {"cookie": token}

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    async def _request_with_retry(
        self,
        client: httpx.AsyncClient,
        url: str,
        headers: dict[str, str],
        params: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """GET *url* with exponential back-off on HTTP 429."""
        delay = _RATE_LIMIT_INITIAL_DELAY
        total_attempts = _RATE_LIMIT_MAX_RETRIES + 1
        for attempt in range(total_attempts):
            resp = await client.get(url, params=params, headers=headers)
            if resp.status_code != 429:
                return resp
            if attempt == total_attempts - 1:
                raise RuntimeError("rate limit reached on patreon.com")
            self.logger.warning(
                "Rate limited by Patreon, backing off",
                extra={
                    "job_id": self.job_id,
                    "url": url,
                    "attempt": attempt + 1,
                    "wait_seconds": delay,
                },
            )
            if self.flush_callback:
                await self.flush_callback(
                    [], [], self._last_flush_progress,
                    f"Rate limited — waiting {delay}s before retry"
                    f" (attempt {attempt + 1}/{total_attempts})",
                )
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
        raise RuntimeError("rate limit reached on patreon.com")  # unreachable

    # ------------------------------------------------------------------
    # API data fetchers
    # ------------------------------------------------------------------

    async def _fetch_campaign_by_vanity(
        self,
        client: httpx.AsyncClient,
        vanity: str,
        headers: dict[str, str],
    ) -> tuple[str, str, str | None, str | None, str | None] | None:
        """Return ``(campaign_id, user_id, creator_name, avatar_url, banner_url)`` for *vanity*, or ``None``."""
        try:
            resp = await self._request_with_retry(
                client,
                f"{BASE_URL}/api/campaigns",
                headers,
                params={
                    "filter[vanity]": vanity,
                    "fields[campaign]": "vanity,creation_name,cover_photo_url,image_url",
                    "include": "creator",
                    "fields[user]": "full_name,image_url,thumb_url",
                    "json-api-version": "1.0",
                    "json-api-use-default-includes": "false",
                },
            )
            resp.raise_for_status()
        except Exception as exc:
            self.logger.error(
                "Failed to fetch campaign for vanity",
                extra={"job_id": self.job_id, "vanity": vanity, "error": str(exc)},
            )
            return None

        data = resp.json()
        campaigns: list[dict[str, Any]] = data.get("data") or []
        if not campaigns:
            self.logger.warning(
                "No campaign found for vanity",
                extra={"job_id": self.job_id, "vanity": vanity},
            )
            return None

        campaign = campaigns[0]
        campaign_id: str = campaign["id"]
        campaign_attrs: dict[str, Any] = campaign.get("attributes") or {}
        banner_url: str | None = (
            campaign_attrs.get("cover_photo_url") or campaign_attrs.get("image_url") or None
        )

        # Resolve the creator (user) ID from relationships.
        creator_ref: dict[str, Any] = (
            (campaign.get("relationships") or {})
            .get("creator", {})
            .get("data") or {}
        )
        user_id: str | None = creator_ref.get("id")
        if not user_id:
            self.logger.error(
                "Campaign has no creator relationship",
                extra={"job_id": self.job_id, "campaign_id": campaign_id},
            )
            return None

        # Try to get creator name and avatar from included data.
        included_map = _build_included_map(data.get("included") or [])
        user_obj = included_map.get(f"user:{user_id}")
        user_attrs: dict[str, Any] = (user_obj.get("attributes") or {}) if user_obj else {}
        creator_name: str | None = user_attrs.get("full_name") or None
        avatar_url: str | None = user_attrs.get("image_url") or user_attrs.get("thumb_url") or None

        self.logger.info(
            "Resolved campaign",
            extra={
                "job_id": self.job_id,
                "vanity": vanity,
                "campaign_id": campaign_id,
                "user_id": user_id,
            },
        )
        return campaign_id, user_id, creator_name, avatar_url, banner_url

    async def _fetch_subscribed_campaigns(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
    ) -> list[tuple[str, str, str | None, str | None, str | None]]:
        """Return ``[(campaign_id, user_id, creator_name, avatar_url, banner_url)]`` for all active memberships."""
        try:
            resp = await self._request_with_retry(
                client,
                f"{BASE_URL}/api/current_user",
                headers,
                params={
                    "include": "active_memberships.campaign.creator",
                    "fields[campaign]": "vanity,creation_name,cover_photo_url,image_url",
                    "fields[user]": "full_name,image_url,thumb_url",
                    "fields[member]": "is_free_member",
                    "json-api-version": "1.0",
                    "json-api-use-default-includes": "false",
                },
            )
            if resp.status_code == 401:
                raise ValueError(
                    "Invalid Patreon session cookie — please log in to Patreon first."
                )
            resp.raise_for_status()
        except ValueError:
            raise
        except Exception as exc:
            self.logger.error(
                "Failed to fetch current user memberships",
                extra={"job_id": self.job_id, "error": str(exc)},
            )
            return []

        data = resp.json()
        included_map = _build_included_map(data.get("included") or [])

        memberships_rels: list[dict[str, Any]] = (
            (data.get("data") or {})
            .get("relationships", {})
            .get("active_memberships", {})
            .get("data") or []
        )

        result: list[tuple[str, str, str | None, str | None, str | None]] = []
        for m_ref in memberships_rels:
            m_obj = included_map.get(f"member:{m_ref.get('id', '')}")
            if not m_obj:
                continue
            campaign_ref: dict[str, Any] = (
                (m_obj.get("relationships") or {})
                .get("campaign", {})
                .get("data") or {}
            )
            campaign_id = campaign_ref.get("id")
            if not campaign_id:
                continue
            campaign_obj = included_map.get(f"campaign:{campaign_id}")
            if not campaign_obj:
                continue
            campaign_attrs: dict[str, Any] = campaign_obj.get("attributes") or {}
            banner_url: str | None = (
                campaign_attrs.get("cover_photo_url") or campaign_attrs.get("image_url") or None
            )
            user_ref: dict[str, Any] = (
                (campaign_obj.get("relationships") or {})
                .get("creator", {})
                .get("data") or {}
            )
            user_id = user_ref.get("id")
            if not user_id:
                continue
            user_obj = included_map.get(f"user:{user_id}")
            user_attrs: dict[str, Any] = (user_obj.get("attributes") or {}) if user_obj else {}
            creator_name: str | None = user_attrs.get("full_name") or None
            avatar_url: str | None = user_attrs.get("image_url") or user_attrs.get("thumb_url") or None
            result.append((campaign_id, user_id, creator_name, avatar_url, banner_url))

        self.logger.info(
            "Fetched subscribed campaigns",
            extra={"job_id": self.job_id, "count": len(result)},
        )
        return result

    async def _fetch_creator_avatar(
        self,
        client: httpx.AsyncClient,
        user_id: str,
        headers: dict[str, str],
    ) -> str | None:
        """Fetch creator avatar URL from their profile page."""
        try:
            resp = await self._request_with_retry(
                client,
                f"{BASE_URL}/api/user/{user_id}",
                headers,
                params={
                    "fields[user]": "image_url,thumb_url",
                    "json-api-version": "1.0",
                    "json-api-use-default-includes": "false",
                },
            )
            if resp.status_code in (401, 404):
                return None
            resp.raise_for_status()
            data = resp.json()
            attrs = (data.get("data") or {}).get("attributes") or {}
            return attrs.get("image_url") or attrs.get("thumb_url") or None
        except Exception as exc:
            self.logger.warning(
                "Failed to fetch creator avatar, skipping",
                extra={"job_id": self.job_id, "user_id": user_id, "error": str(exc)},
            )
            return None

    def _parse_content(
        self, data: dict[str, Any]
    ) -> str | None:
        """Return post content HTML.

        Returns ``data['content']`` if non-empty.  Otherwise attempts to
        assemble HTML from ``data['content_json_string']`` (ProseMirror JSON
        format used by Patreon when the legacy ``content`` field is absent).

        Inspired by the fix in patreon-dl:
        https://github.com/patrickkfkan/patreon-dl/commit/a9cc4d2bf1d465f83b6ea5a676c509d80de124aa
        """
        content = data.get("content")
        if isinstance(content, str) and content.strip():
            return content

        content_json_string = data.get("content_json_string")
        if not content_json_string:
            return None

        try:
            doc = content_json_string
            if isinstance(doc, str):
                doc = json.loads(doc)

            html_parts: list[str] = []

            def _extract(node: Any) -> None:
                if not node:
                    return
                node_type = node.get("type") if isinstance(node, dict) else None
                if node_type == "text":
                    text = node.get("text") or ""
                    marks = node.get("marks") or []
                    link_mark = next(
                        (m for m in marks if isinstance(m, dict) and m.get("type") == "link"),
                        None,
                    )
                    if link_mark:
                        href = html.escape((link_mark.get("attrs") or {}).get("href", ""), quote=True)
                        html_parts.append(f'<a href="{href}" target="_blank">{html.escape(text)}</a>')
                    else:
                        html_parts.append(html.escape(text))
                elif node_type in ("paragraph", "heading", "listItem"):
                    html_parts.append("<p>")
                    for child in node.get("content") or []:
                        _extract(child)
                    html_parts.append("</p>")
                elif node_type == "image":
                    attrs = node.get("attrs") or {}
                    media_id = html.escape(str(attrs.get("media_id", "")), quote=True)
                    src = html.escape(str(attrs.get("src", "")), quote=True)
                    media_id_attr = f'data-media-id="{media_id}" ' if media_id else ""
                    html_parts.append(f'<img {media_id_attr}src="{src}" />')
                else:
                    for child in node.get("content") or []:
                        _extract(child)

            _extract(doc)
            return "".join(html_parts) or None
        except Exception as exc:
            self.logger.warning(
                "Failed to parse content_json_string",
                extra={"job_id": self.job_id, "error": str(exc)},
            )
            return None

    async def _stream_media(
        self,
        download_url: str,
        file_name: str,
        media_type: str,
        headers: dict[str, str],
    ) -> ScrapedAttachment:
        """Download a Patreon media file and stream it to S3."""
        self.logger.debug(
            "Streaming Patreon media to S3",
            extra={"job_id": self.job_id, "file_name": file_name},
        )
        # Remove cookie from download headers — the CDN uses the URL token,
        # not the session cookie.
        download_headers = {
            k: v for k, v in headers.items()
            if k.lower() not in ("cookie", "accept")
        }
        s3_key = await stream_url_to_s3(
            download_url,
            headers=download_headers,
            key_prefix="patreon",
        )
        return ScrapedAttachment(
            file_url=s3_key,
            data_type=_data_type_for_media(media_type, file_name),
            name=file_name or None,
        )

    # ------------------------------------------------------------------
    # Post pagination
    # ------------------------------------------------------------------

    async def _fetch_posts_page(
        self,
        client: httpx.AsyncClient,
        url: str,
        headers: dict[str, str],
        params: dict[str, Any] | None,
    ) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], str | None]:
        """Fetch one page of posts.

        Returns ``(post_data_list, included_map, next_page_url_or_none)``.
        """
        resp = await self._request_with_retry(client, url, headers, params)
        resp.raise_for_status()
        body = resp.json()
        posts: list[dict[str, Any]] = body.get("data") or []
        included_map = _build_included_map(body.get("included") or [])
        next_url: str | None = (body.get("links") or {}).get("next")
        return posts, included_map, next_url

    # ------------------------------------------------------------------
    # Per-post processing
    # ------------------------------------------------------------------

    async def _process_post(
        self,
        post_data: dict[str, Any],
        included_map: dict[str, dict[str, Any]],
        user_id: str,
        creator_name: str | None,
        creator_thumbnail_url: str | None,
        creator_banner_url: str | None,
        headers: dict[str, str],
    ) -> ScrapedPost | None:
        """Build a :class:`ScrapedPost` for one Patreon post JSON:API object."""
        post_id: str | None = post_data.get("id")
        if not post_id:
            return None

        attrs: dict[str, Any] = post_data.get("attributes") or {}
        title: str | None = (attrs.get("title") or "").strip() or None
        content: str | None = self._parse_content(attrs)
        if content is None:
            content = self._parse_content({
                "content": attrs.get("teaser_text"),
                "content_json_string": attrs.get("teaser_text_json_string"),
            })
        published_at: str | None = attrs.get("published_at") or None

        # Resolve media relationships → included objects.
        rels: dict[str, Any] = post_data.get("relationships") or {}

        def _resolve_refs(rel_key: str) -> list[dict[str, Any]]:
            rel_data = (rels.get(rel_key) or {}).get("data")
            if not rel_data:
                return []
            if isinstance(rel_data, list):
                refs = rel_data
            else:
                refs = [rel_data]
            return [
                obj for ref in refs
                if (obj := included_map.get(f"{ref.get('type', '')}:{ref.get('id', '')}"))
            ]

        attachments: list[ScrapedAttachment] = []

        # Build a set of media IDs that appear in images/audio/attachments_media
        # so we can detect embedded content-only images separately.
        explicit_media_ids: set[str] = set()
        for rel_key in ("images", "audio", "attachments_media"):
            rel_data = (rels.get(rel_key) or {}).get("data")
            if not rel_data:
                continue
            refs = rel_data if isinstance(rel_data, list) else [rel_data]
            for ref in refs:
                explicit_media_ids.add(str(ref.get("id", "")))

        # Process images.
        for media_obj in _resolve_refs("images"):
            media_attrs = media_obj.get("attributes") or {}
            dl_url: str | None = media_attrs.get("download_url")
            if not dl_url:
                continue
            try:
                att = await self._stream_media(
                    dl_url,
                    media_attrs.get("file_name", ""),
                    media_attrs.get("media_type", "image"),
                    headers,
                )
                attachments.append(att)
            except Exception as exc:
                self.logger.warning(
                    "Failed to stream image, skipping",
                    extra={"job_id": self.job_id, "post_id": post_id, "error": str(exc)},
                )

        # Process audio.
        for media_obj in _resolve_refs("audio"):
            media_attrs = media_obj.get("attributes") or {}
            dl_url = media_attrs.get("download_url")
            if not dl_url:
                continue
            try:
                att = await self._stream_media(
                    dl_url,
                    media_attrs.get("file_name", ""),
                    "audio",
                    headers,
                )
                attachments.append(att)
            except Exception as exc:
                self.logger.warning(
                    "Failed to stream audio, skipping",
                    extra={"job_id": self.job_id, "post_id": post_id, "error": str(exc)},
                )

        # Process file attachments.
        for media_obj in _resolve_refs("attachments_media"):
            media_attrs = media_obj.get("attributes") or {}
            dl_url = media_attrs.get("download_url")
            if not dl_url:
                continue
            try:
                att = await self._stream_media(
                    dl_url,
                    media_attrs.get("file_name", ""),
                    media_attrs.get("media_type", ""),
                    headers,
                )
                attachments.append(att)
            except Exception as exc:
                self.logger.warning(
                    "Failed to stream attachment, skipping",
                    extra={"job_id": self.job_id, "post_id": post_id, "error": str(exc)},
                )

        # Extract images embedded in post content (content_json_string image nodes)
        # that are NOT already captured by the images relationship above.
        if content:
            img_srcs = re.findall(
                r'<img[^>]*\sdata-media-id="([^"]*)"[^>]*\ssrc="([^"]*)"',
                content,
            ) + re.findall(
                r'<img[^>]*\ssrc="([^"]*)"[^>]*(?:data-media-id="[^"]*")?',
                content,
            )
            # Use a simpler regex to capture all img src + optional media-id pairs
            embedded_imgs = re.findall(
                r'<img(?:[^>]*?\sdata-media-id="([^"]*)")?[^>]*?\ssrc="([^"]+)"',
                content,
            )
            for media_id, src in embedded_imgs:
                # Skip if already captured as an explicit attachment
                if media_id and media_id in explicit_media_ids:
                    continue
                if not src or src.startswith("data:"):
                    continue
                try:
                    att = await self._stream_media(
                        src,
                        src.split("/")[-1].split("?")[0] or "embedded_image",
                        "image",
                        headers,
                    )
                    attachments.append(att)
                except Exception as exc:
                    self.logger.warning(
                        "Failed to stream embedded content image, skipping",
                        extra={"job_id": self.job_id, "post_id": post_id, "src": src, "error": str(exc)},
                    )

        return ScrapedPost(
            external_id=post_id,
            creator_external_id=user_id,
            # Use "patreon" so this post shares the same Creator record
            # as any Kemono-sourced Patreon posts for the same creator.
            service_type="patreon",
            title=title,
            content=content,
            published_at=published_at,
            attachments=attachments,
            comments=[],
            historical_revisions=[],
            creator_name=creator_name,
            creator_thumbnail_url=creator_thumbnail_url,
            creator_banner_url=creator_banner_url,
        )

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def scrape(self) -> ScrapeResult:  # noqa: C901 (complexity accepted)
        self.logger.info("Starting Patreon scrape", extra={"job_id": self.job_id})
        result = ScrapeResult()
        vanity, headers = self._parse_token()

        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            # Build the list of (campaign_id, user_id, creator_name, avatar_url, banner_url) to process.
            creators: list[tuple[str, str, str | None, str | None, str | None]] = []

            if vanity is not None:
                info = await self._fetch_campaign_by_vanity(client, vanity, headers)
                if info is None:
                    self.logger.error(
                        "Could not resolve Patreon creator",
                        extra={"job_id": self.job_id, "vanity": vanity},
                    )
                    result.error = f"Creator '{vanity}' not found on Patreon."
                    return result
                creators.append(info)
            else:
                creators = await self._fetch_subscribed_campaigns(client, headers)

            if not creators:
                self.logger.info(
                    "No creators found to import",
                    extra={"job_id": self.job_id},
                )
                result.progress_pct = 100
                return result

            self.logger.info(
                "Creators to import",
                extra={"job_id": self.job_id, "count": len(creators)},
            )

            total_creators = len(creators)
            for creator_idx, (campaign_id, user_id, creator_name, raw_avatar_url, raw_banner_url) in enumerate(creators):
                creator_progress_base = int(creator_idx / total_creators * 100)

                if self.flush_callback:
                    await self.flush_callback(
                        [], [], creator_progress_base,
                        f"Fetching posts for creator {creator_idx + 1}/{total_creators} "
                        f"(Patreon user {user_id})…",
                    )

                # Fall back to a dedicated avatar API call if the campaign response
                # did not include the user's image_url.
                if not raw_avatar_url:
                    raw_avatar_url = await self._fetch_creator_avatar(
                        client, user_id, headers
                    )

                # Stream creator avatar to S3.
                creator_thumbnail_url: str | None = None
                if raw_avatar_url:
                    try:
                        creator_thumbnail_url = await stream_url_to_s3(
                            raw_avatar_url,
                            headers={},
                            key_prefix="patreon/thumbnails",
                        )
                    except Exception as exc:
                        self.logger.warning(
                            "Failed to download creator avatar",
                            extra={
                                "job_id": self.job_id,
                                "user_id": user_id,
                                "error": str(exc),
                            },
                        )

                # Stream creator banner to S3.
                creator_banner_url: str | None = None
                if raw_banner_url:
                    try:
                        creator_banner_url = await stream_url_to_s3(
                            raw_banner_url,
                            headers={},
                            key_prefix="patreon/banners",
                        )
                    except Exception as exc:
                        self.logger.warning(
                            "Failed to download creator banner",
                            extra={
                                "job_id": self.job_id,
                                "user_id": user_id,
                                "error": str(exc),
                            },
                        )

                # Paginate through all posts for this campaign.
                post_url = f"{BASE_URL}/api/posts"
                post_params: dict[str, Any] = {
                    "filter[campaign_id]": campaign_id,
                    "filter[contains_exclusive_posts]": "true",
                    "filter[is_draft]": "false",
                    "include": "campaign,audio,images,attachments_media,user",
                    "fields[post]": (
                        "title,content,content_json_string,teaser_text,"
                        "teaser_text_json_string,published_at,post_type,image,url,"
                        "current_user_can_view"
                    ),
                    "fields[media]": "download_url,file_name,media_type,mimetype",
                    "fields[user]": "full_name,image_url",
                    "sort": "-published_at",
                    "page[count]": str(PAGE_SIZE),
                    "json-api-version": "1.0",
                    "json-api-use-default-includes": "false",
                }
                page_num = 0
                total_imported = 0

                while post_url:
                    try:
                        page_posts, page_included, next_post_url = (
                            await self._fetch_posts_page(
                                client, post_url, headers, post_params
                            )
                        )
                    except Exception as exc:
                        self.logger.error(
                            "Failed to fetch posts page, stopping pagination",
                            extra={
                                "job_id": self.job_id,
                                "user_id": user_id,
                                "page": page_num,
                                "error": str(exc),
                            },
                        )
                        break

                    # After the first page, the next URL carries all params.
                    post_params = None  # type: ignore[assignment]
                    page_num += 1

                    processed_posts: list[ScrapedPost] = []
                    for raw_post in page_posts:
                        try:
                            scraped = await self._process_post(
                                raw_post,
                                page_included,
                                user_id,
                                creator_name,
                                creator_thumbnail_url,
                                creator_banner_url,
                                headers,
                            )
                            if scraped:
                                processed_posts.append(scraped)
                        except Exception as exc:
                            self.logger.warning(
                                "Failed to process post, skipping",
                                extra={
                                    "job_id": self.job_id,
                                    "post_id": raw_post.get("id"),
                                    "error": str(exc),
                                },
                            )

                    total_imported += len(processed_posts)
                    # Progress within this creator's slot: use 1 - 1/(page+1)
                    # which grows monotonically from 0.5 → 0.67 → 0.75 → …
                    # and is capped at 95% until scraping completes.
                    creator_slot = 100 // total_creators
                    within_creator = min(0.95, 1.0 - 1.0 / (page_num + 1))
                    progress = creator_progress_base + int(within_creator * creator_slot)
                    self._last_flush_progress = progress

                    if processed_posts:
                        if self.flush_callback:
                            await self.flush_callback(
                                processed_posts,
                                [],
                                progress,
                                f"Imported page {page_num}: "
                                f"{len(processed_posts)} posts "
                                f"(total: {total_imported})",
                            )
                        else:
                            result.posts.extend(processed_posts)

                    post_url = next_post_url or ""
                    if post_url:
                        await asyncio.sleep(0.3)  # be polite to the server

        result.progress_pct = 100
        return result
