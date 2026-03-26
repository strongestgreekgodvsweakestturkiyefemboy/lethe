from __future__ import annotations

import asyncio
import json
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
    ScrapedPostRevision,
)
from core.s3_streamer import stream_url_to_s3

BASE_URL = "https://kemono.cr"
PAGE_SIZE = 50

# Initial back-off delay (seconds) when a 429 is received.
_RATE_LIMIT_INITIAL_DELAY = 60
# Maximum back-off delay (seconds).
_RATE_LIMIT_MAX_DELAY = 600
# Maximum number of retries before giving up on a single request.
_RATE_LIMIT_MAX_RETRIES = 5
# Politeness delay (seconds) inserted between individual post requests.
# Configurable via POST_DELAY_SECONDS env var; defaults to 2 seconds.
_POST_DELAY_SECONDS: float = float(os.environ.get("POST_DELAY_SECONDS", "2"))

# Retry configuration for CDN 500 errors on attachment downloads.
# On a 500 the affected post is deferred to the end of the queue.  If the
# CDN keeps returning 500 for successive retries, we back off exponentially
# up to _CDN_500_MAX_DELAY seconds before each attempt.
_CDN_500_INITIAL_DELAY: float = 30.0   # first retry back-off in seconds
_CDN_500_MAX_DELAY: float = 300.0      # hard cap — 5 minutes
_CDN_500_MAX_RETRIES: int = 5          # give up after this many per-post attempts

# All service names recognised by Kemono
KNOWN_SERVICES = {
    "patreon",
    "fanbox",
    "gumroad",
    "subscribestar",
    "onlyfans",
    "fansly",
    "boosty",
    "dlsite",
    "discord",
    "fantia",
}

_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v", ".wmv"}
_AUDIO_EXTS = {".mp3", ".ogg", ".wav", ".flac", ".aac", ".m4a", ".opus"}


def _data_type_for_path(path: str) -> str:
    """Infer DataType from a file path extension."""
    ext = ("." + path.rsplit(".", 1)[-1].lower()) if "." in path else ""
    if ext in _IMAGE_EXTS:
        return "IMAGE"
    if ext in _VIDEO_EXTS:
        return "VIDEO"
    if ext in _AUDIO_EXTS:
        return "AUDIO"
    return "FILE"  # zip, psd, pdf, clip, etc.


def _fix_content_image_paths(content: str) -> str:
    """Make relative /data/... image src paths in HTML content absolute.

    Kemono stores inline image src attributes as root-relative paths like
    ``/data/patreon/file/…``.  These are resolved against kemono.cr, so we
    prepend the base URL so they render correctly when the HTML is displayed
    on our own frontend.  Absolute URLs (starting with http/https) are left
    unchanged.
    """
    # Match only root-relative paths (start with /, not with http/https/ftp …)
    content = re.sub(
        r'src="((?!https?://|ftp://)/[^"]*)"',
        lambda m: f'src="{BASE_URL}{m.group(1)}"',
        content,
    )
    content = re.sub(
        r"src='((?!https?://|ftp://)/[^']*)'",
        lambda m: f"src='{BASE_URL}{m.group(1)}'",
        content,
    )
    return content


class KemonoScraper(BaseScraper):
    """Scrapes creator posts and media from Kemono (kemono.cr).

    Token format (one of):

    * ``{service}/{creator_id}`` — import a specific public creator, e.g.
      ``patreon/12345`` or ``fanbox/myartist``.  No authentication needed.
    * A raw Kemono session-cookie value — the scraper will fetch the
      authenticated user's favourited artists and import all of them.
    """

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        # Tracks the last successfully flushed progress percentage so that
        # rate-limit wait callbacks don't reset the progress bar to 0.
        self._last_flush_progress: int = 0

    @property
    def site_name(self) -> str:
        return "kemono"

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _parse_token(self) -> tuple[list[tuple[str, str]], dict[str, str]]:
        """Return ``(creators, http_headers)``.

        *creators* is a (possibly empty) list of ``(service, creator_id)``
        pairs.  When the token is a session cookie, the list is empty and
        the caller should fetch favourites first.

        Accepted token formats:
        * Full Kemono URL — ``https://kemono.cr/{service}/user/{creator_id}``
          (any trailing path such as ``/post/{id}`` is silently ignored).
        * ``{service}/{creator_id}`` — import a specific public creator.
        * A raw Kemono session-cookie value — import all favourited artists.
        """
        token = self.session_token.strip()

        # Handle full Kemono URLs:
        #   https://kemono.cr/patreon/user/175695623
        #   https://kemono.cr/patreon/user/175695623/post/135706662
        url_match = re.search(
            r"kemono\.(?:cr|party)/([a-zA-Z0-9_-]+)/user/([^/?#\s]+)",
            token,
            re.IGNORECASE,
        )
        if url_match:
            service = url_match.group(1).lower()
            creator_id = url_match.group(2)
            if service in KNOWN_SERVICES:
                self.logger.debug(
                    "Token parsed as Kemono URL",
                    extra={"job_id": self.job_id, "service": service},
                )
                return [(service, creator_id)], {}

        parts = token.split("/", 1)
        if len(parts) == 2 and parts[0].lower() in KNOWN_SERVICES:
            self.logger.debug(
                "Token parsed as service/creator_id",
                extra={"job_id": self.job_id, "service": parts[0].lower()},
            )
            return [(parts[0].lower(), parts[1])], {}
        # Treat the whole token as a Kemono session cookie
        self.logger.debug("Token parsed as session cookie", extra={"job_id": self.job_id})
        return [], {"cookie": f"session={token}"}

    async def _request_with_retry(
        self,
        client: httpx.AsyncClient,
        url: str,
        headers: dict[str, str],
        params: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """GET *url*, retrying with exponential back-off on HTTP 429 responses.

        Makes up to ``_RATE_LIMIT_MAX_RETRIES + 1`` total attempts.
        Raises ``RuntimeError`` if all attempts are rate-limited.
        """
        delay = _RATE_LIMIT_INITIAL_DELAY
        total_attempts = _RATE_LIMIT_MAX_RETRIES + 1
        for attempt in range(total_attempts):
            resp = await client.get(url, params=params, headers=headers)
            if resp.status_code != 429:
                return resp
            if attempt == total_attempts - 1:
                raise RuntimeError("rate limit reached on kemono.cr")
            self.logger.warning(
                "Rate limited by Kemono, backing off before retry",
                extra={
                    "job_id": self.job_id,
                    "url": url,
                    "attempt": attempt + 1,
                    "total_attempts": total_attempts,
                    "wait_seconds": delay,
                },
            )
            if self.flush_callback:
                await self.flush_callback(
                    [],
                    [],
                    self._last_flush_progress,
                    f"Rate limited — waiting {delay}s before retry"
                    f" (attempt {attempt + 1}/{total_attempts})",
                )
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
        raise RuntimeError("rate limit reached on kemono.cr")  # unreachable

    async def _fetch_favorites(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
    ) -> list[tuple[str, str]]:
        self.logger.debug("Fetching favourited artists", extra={"job_id": self.job_id})
        resp = await self._request_with_retry(
            client,
            f"{BASE_URL}/api/v1/account/favorites",
            headers,
            params={"type": "artist"},
        )
        if resp.status_code == 401:
            self.logger.error(
                "Invalid Kemono session cookie",
                extra={"job_id": self.job_id, "status_code": resp.status_code},
            )
            raise ValueError(
                "Invalid Kemono session cookie — please log in to kemono.cr first."
            )
        resp.raise_for_status()
        data: list[dict[str, Any]] = resp.json()
        self.logger.info(
            "Fetched favourited artists",
            extra={"job_id": self.job_id, "count": len(data)},
        )
        return [(artist["service"], str(artist["id"])) for artist in data]

    async def _fetch_all_posts(
        self,
        client: httpx.AsyncClient,
        service: str,
        creator_id: str,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        self.logger.debug(
            "Fetching posts for creator",
            extra={"job_id": self.job_id, "service": service, "creator_id": creator_id},
        )
        posts: list[dict[str, Any]] = []
        offset = 0
        while True:
            resp = await self._request_with_retry(
                client,
                f"{BASE_URL}/api/v1/{service}/user/{creator_id}/posts",
                headers,
                params={"o": offset},
            )
            resp.raise_for_status()
            page: list[dict[str, Any]] = resp.json()
            if not page:
                break
            posts.extend(page)
            self.logger.debug(
                "Fetched post page",
                extra={
                    "job_id": self.job_id,
                    "service": service,
                    "creator_id": creator_id,
                    "offset": offset,
                    "page_size": len(page),
                    "total_so_far": len(posts),
                },
            )
            if len(page) < PAGE_SIZE:
                break
            offset += PAGE_SIZE
            await asyncio.sleep(0.3)  # be polite to the server
        self.logger.info(
            "All posts fetched for creator",
            extra={"job_id": self.job_id, "service": service, "creator_id": creator_id, "total": len(posts)},
        )
        return posts

    async def _fetch_post_detail(
        self,
        client: httpx.AsyncClient,
        service: str,
        creator_id: str,
        post_id: str,
        headers: dict[str, str],
    ) -> dict[str, Any] | None:
        """Fetch full data for a single post.

        The listing endpoint (``/posts``) only returns a summary with empty
        ``file`` and ``attachments`` fields.  This method calls the individual
        post endpoint to get the complete content and file data.

        Returns ``None`` on 404 or request errors (caller should fall back to
        the listing data in that case).
        """
        try:
            resp = await self._request_with_retry(
                client,
                f"{BASE_URL}/api/v1/{service}/user/{creator_id}/post/{post_id}",
                headers,
            )
            if resp.status_code == 404:
                self.logger.warning(
                    "Post detail not found",
                    extra={"job_id": self.job_id, "post_id": post_id},
                )
                return None
            resp.raise_for_status()
            return resp.json()
        except (httpx.HTTPStatusError, httpx.RequestError) as exc:
            self.logger.warning(
                "Failed to fetch post detail, falling back to listing data",
                extra={"job_id": self.job_id, "post_id": post_id, "error": str(exc)},
            )
            return None

    async def _fetch_post_revisions(
        self,
        client: httpx.AsyncClient,
        service: str,
        creator_id: str,
        post_id: str,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        """Fetch all saved revisions for a single post.

        Returns an empty list when the endpoint is unavailable or returns no
        data.
        """
        try:
            resp = await self._request_with_retry(
                client,
                f"{BASE_URL}/api/v1/{service}/user/{creator_id}/post/{post_id}/revisions",
                headers,
            )
            if resp.status_code in (401, 404):
                return []
            resp.raise_for_status()
            revisions: list[dict[str, Any]] = resp.json()
            self.logger.debug(
                "Fetched post revisions",
                extra={
                    "job_id": self.job_id,
                    "post_id": post_id,
                    "revision_count": len(revisions),
                },
            )
            return revisions
        except (httpx.HTTPStatusError, httpx.RequestError) as exc:
            self.logger.warning(
                "Failed to fetch post revisions, skipping",
                extra={"job_id": self.job_id, "post_id": post_id, "error": str(exc)},
            )
            return []

    async def _fetch_comments(
        self,
        client: httpx.AsyncClient,
        service: str,
        creator_id: str,
        post_id: str,
        headers: dict[str, str],
    ) -> list[ScrapedComment]:
        """Fetch comments for a single post from Kemono.

        Returns an empty list if the endpoint is unavailable or returns no data.
        """
        try:
            resp = await self._request_with_retry(
                client,
                f"{BASE_URL}/api/v1/{service}/user/{creator_id}/post/{post_id}/comments",
                headers,
            )
            if resp.status_code == 404:
                return []
            resp.raise_for_status()
            raw: list[dict[str, Any]] = resp.json()
        except (httpx.HTTPStatusError, httpx.RequestError) as exc:
            self.logger.warning(
                "Failed to fetch comments, skipping",
                extra={"job_id": self.job_id, "post_id": post_id, "error": str(exc)},
            )
            return []

        comments: list[ScrapedComment] = []
        for c in raw:
            comment_id = str(c.get("id", ""))
            content = (c.get("content") or "").strip()
            if not comment_id or not content:
                continue
            comments.append(
                ScrapedComment(
                    external_id=comment_id,
                    content=content,
                    author_name=c.get("author") or None,
                published_at=(c.get("published") or "").strip() or None,
                )
            )
        return comments

    async def _fetch_creator_profile(
        self,
        client: httpx.AsyncClient,
        service: str,
        creator_id: str,
        headers: dict[str, str],
    ) -> dict[str, Any] | None:
        """Fetch creator profile info (name, icon) from Kemono.

        Returns ``None`` when the endpoint is unavailable or returns no data.
        """
        try:
            resp = await self._request_with_retry(
                client,
                f"{BASE_URL}/api/v1/{service}/user/{creator_id}/profile",
                headers,
            )
            if resp.status_code in (401, 404):
                return None
            resp.raise_for_status()
            return resp.json()
        except (httpx.HTTPStatusError, httpx.RequestError) as exc:
            self.logger.warning(
                "Failed to fetch creator profile, skipping",
                extra={"job_id": self.job_id, "creator_id": creator_id, "error": str(exc)},
            )
            return None

    async def _stream_attachment(
        self,
        path: str,
        service: str,
        headers: dict[str, str],
        name: str | None = None,
    ) -> ScrapedAttachment:
        self.logger.debug(
            "Streaming attachment to S3",
            extra={"job_id": self.job_id, "path": path, "service": service},
        )
        # The Accept: text/css header is only needed for Kemono's JSON API
        # endpoints.  For binary file downloads we strip it so the CDN serves
        # the actual file content instead of potentially returning an error.
        download_headers = {k: v for k, v in headers.items() if k.lower() != "accept"}
        s3_key = await stream_url_to_s3(
            f"{BASE_URL}/data{path}",
            headers=download_headers,
            key_prefix=f"kemono/{service}",
        )
        self.logger.debug(
            "Attachment streamed to S3",
            extra={"job_id": self.job_id, "s3_key": s3_key},
        )
        return ScrapedAttachment(
            file_url=s3_key,
            data_type=_data_type_for_path(path),
            name=name,
        )

    # ------------------------------------------------------------------
    # Per-post processing helper
    # ------------------------------------------------------------------

    async def _process_single_post(
        self,
        client: httpx.AsyncClient,
        service: str,
        creator_id: str,
        listing_post: dict[str, Any],
        headers: dict[str, str],
        creator_profiles: dict[tuple[str, str], dict[str, Any]],
        creator_s3_images: dict[tuple[str, str], tuple[str | None, str | None]],
    ) -> ScrapedPost | None:
        """Fetch full post data and stream all attachments to S3.

        Returns ``None`` when the listing post carries no usable ID.

        May raise :class:`httpx.HTTPStatusError` (e.g. HTTP 500) when an
        attachment CDN request fails — callers should catch this and decide
        whether to defer the post for a later retry.
        """
        post_id: str | None = str(listing_post["id"]) if listing_post.get("id") else None
        published_at: str | None = listing_post.get("published") or listing_post.get("added")

        self.logger.debug(
            "Processing post",
            extra={
                "job_id": self.job_id,
                "post_id": post_id,
                "service": service,
                "published_at": published_at,
            },
        )

        if not post_id:
            return None

        # Fetch the full post detail — the listing endpoint only
        # returns a summary with empty file/attachments fields.
        detail = await self._fetch_post_detail(
            client, service, creator_id, post_id, headers
        )

        # The detail endpoint wraps the post under a "post" key:
        #   { "post": {...}, "attachments": [...], "props": {...} }
        # Extract the inner post object; fall back to listing data on
        # failure so we at least record the title and timestamp.
        if detail is None:
            post = listing_post
            detail_props: dict[str, Any] = {}
            self.logger.debug(
                "Using listing data as fallback for post",
                extra={"job_id": self.job_id, "post_id": post_id},
            )
        else:
            post = detail.get("post") or listing_post
            detail_props = detail.get("props") or {}
            self.logger.debug(
                "Raw Kemono post detail for %s:\n%s",
                post_id,
                json.dumps(detail, indent=2),
            )

        title = (post.get("title") or "").strip() or None
        raw_body = (post.get("content") or "").strip() or None
        # Make any relative /data/... image src paths in the HTML
        # content absolute so they load directly from kemono.cr CDN.
        body = _fix_content_image_paths(raw_body) if raw_body else None

        # Collect file attachments
        attachments: list[ScrapedAttachment] = []

        main_file: dict[str, Any] | None = post.get("file")
        if main_file and main_file.get("path"):
            attachments.append(
                await self._stream_attachment(
                    main_file["path"],
                    service,
                    headers,
                    name=main_file.get("name"),
                )
            )

        for attachment in post.get("attachments") or []:
            if attachment.get("path"):
                attachments.append(
                    await self._stream_attachment(
                        attachment["path"],
                        service,
                        headers,
                        name=attachment.get("name"),
                    )
                )

        # Fetch comments for this post
        comments = await self._fetch_comments(
            client, service, creator_id, post_id, headers
        )

        # Revisions are embedded in detail["props"]["revisions"] as a
        # list of [version_number, post_data] pairs.  Version 1 is the
        # current revision; earlier revisions have a "revision_id" field
        # and are the historical ones we want to store.
        historical_revisions: list[ScrapedPostRevision] = []
        for rev_pair in detail_props.get("revisions") or []:
            if not (isinstance(rev_pair, (list, tuple)) and len(rev_pair) == 2):
                continue
            _rev_num, rev = rev_pair
            if not isinstance(rev, dict):
                continue
            # Only keep old revisions (they carry a numeric revision_id).
            rev_id = str(rev.get("revision_id") or "")
            if not rev_id:
                continue
            historical_revisions.append(
                ScrapedPostRevision(
                    title=(rev.get("title") or "").strip() or None,
                    content=(rev.get("content") or "").strip() or None,
                    published_at=rev.get("published") or rev.get("added"),
                    revision_external_id=rev_id,
                )
            )

        # Look up creator profile for name/thumbnail/banner.
        # S3 URLs were pre-downloaded once per creator above.
        profile = creator_profiles.get((service, creator_id), {})
        creator_name = (profile.get("name") or "").strip() or None
        creator_thumbnail_url, creator_banner_url = creator_s3_images.get(
            (service, creator_id), (None, None)
        )

        return ScrapedPost(
            external_id=post_id,
            creator_external_id=creator_id,
            service_type=service,
            title=title,
            content=body,
            published_at=published_at,
            attachments=attachments,
            comments=comments,
            historical_revisions=historical_revisions,
            creator_name=creator_name,
            creator_thumbnail_url=creator_thumbnail_url,
            creator_banner_url=creator_banner_url,
        )

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def scrape(self) -> ScrapeResult:
        self.logger.info("Starting Kemono scrape", extra={"job_id": self.job_id})
        result = ScrapeResult()
        creators, headers = self._parse_token()

        # kemono.cr returns 403 unless this exact Accept value is sent
        headers["Accept"] = "text/css"

        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            # Resolve creator list from favourites when using a session cookie
            if not creators:
                creators = await self._fetch_favorites(client, headers)

            if not creators:
                self.logger.info(
                    "No creators found, returning empty result",
                    extra={"job_id": self.job_id},
                )
                result.progress_pct = 100
                return result

            self.logger.info(
                "Creators to import",
                extra={"job_id": self.job_id, "creators_count": len(creators)},
            )

            # Fetch creator profiles (name + icon) so we can persist them.
            creator_profiles: dict[tuple[str, str], dict[str, Any]] = {}
            for service, creator_id in creators:
                profile = await self._fetch_creator_profile(client, service, creator_id, headers)
                if profile:
                    creator_profiles[(service, creator_id)] = profile

            # Pre-download creator thumbnails and banners to S3 (once per
            # creator) so the frontend can use presigned URLs.
            # Kemono does not return icon/banner URLs via its API; instead
            # we fetch them directly from the known CDN URL patterns.
            creator_s3_images: dict[tuple[str, str], tuple[str | None, str | None]] = {}
            for service, creator_id in creators:
                s3_thumb: str | None = None
                s3_banner: str | None = None

                # img.kemono.cr is a public CDN — no special headers needed.
                icon_url = f"https://img.kemono.cr/icons/{service}/{creator_id}"
                banner_url = f"https://img.kemono.cr/banners/{service}/{creator_id}"

                try:
                    s3_thumb = await stream_url_to_s3(
                        icon_url,
                        headers={},
                        key_prefix=f"kemono/{service}/thumbnails",
                    )
                except Exception as exc:
                    self.logger.warning(
                        "Failed to download creator icon",
                        extra={"job_id": self.job_id, "creator_id": creator_id, "error": str(exc)},
                    )

                try:
                    s3_banner = await stream_url_to_s3(
                        banner_url,
                        headers={},
                        key_prefix=f"kemono/{service}/banners",
                    )
                except Exception as exc:
                    self.logger.warning(
                        "Failed to download creator banner",
                        extra={"job_id": self.job_id, "creator_id": creator_id, "error": str(exc)},
                    )

                creator_s3_images[(service, creator_id)] = (s3_thumb, s3_banner)

            # Collect all post summaries across every creator first so we can
            # show accurate progress percentages.  Summaries are small (no
            # attachments), so this is memory-safe even for prolific creators.
            all_posts: list[tuple[str, str, dict[str, Any]]] = []
            for service, creator_id in creators:
                if self.flush_callback:
                    await self.flush_callback(
                        [], [], 0,
                        f"Fetching post list for {service}/{creator_id}…",
                    )
                posts = await self._fetch_all_posts(
                    client, service, creator_id, headers
                )
                for post in posts:
                    all_posts.append((service, creator_id, post))

            total = len(all_posts)
            self.logger.info(
                "Total posts to process",
                extra={"job_id": self.job_id, "total_posts": total},
            )
            processed = 0

            # Posts that encounter a CDN 500 error are pushed here and
            # retried after all other posts have been processed, in their
            # original relative order.
            # Each entry is (retry_count, service, creator_id, listing_post).
            deferred_posts: list[tuple[int, str, str, dict[str, Any]]] = []

            for service, creator_id, listing_post in all_posts:
                post_id: str | None = (
                    str(listing_post["id"]) if listing_post.get("id") else None
                )
                try:
                    scraped_post = await self._process_single_post(
                        client, service, creator_id, listing_post, headers,
                        creator_profiles, creator_s3_images,
                    )
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code == 500:
                        self.logger.warning(
                            "CDN 500 error on post, deferring to end of queue",
                            extra={
                                "job_id": self.job_id,
                                "post_id": post_id,
                                "url": str(exc.request.url),
                            },
                        )
                        deferred_posts.append((0, service, creator_id, listing_post))
                        continue
                    raise

                if scraped_post is None:
                    processed += 1
                    result.progress_pct = int(processed / total * 100) if total else 100
                    continue

                processed += 1
                result.progress_pct = int(processed / total * 100) if total else 100
                self._last_flush_progress = result.progress_pct

                # Stream this post to the backend immediately so that data is
                # saved incrementally rather than all at once.
                if self.flush_callback:
                    log_msg = (
                        f"Saved post {post_id} [{service}/{creator_id}]"
                        f" ({processed}/{total}, {result.progress_pct}%)"
                    )
                    await self.flush_callback([scraped_post], [], result.progress_pct, log_msg)
                else:
                    # No callback — accumulate for the final bulk send.
                    result.posts.append(scraped_post)

                # Be polite to the server — wait between posts.
                await asyncio.sleep(_POST_DELAY_SECONDS)

            # ----------------------------------------------------------
            # Retry loop: re-process posts deferred due to CDN 500 errors.
            # Consecutive failures trigger exponential back-off up to
            # _CDN_500_MAX_DELAY seconds (5 minutes).
            # ----------------------------------------------------------
            consecutive_500s = 0
            while deferred_posts:
                retry_count, service, creator_id, listing_post = deferred_posts.pop(0)
                post_id = (
                    str(listing_post["id"]) if listing_post.get("id") else None
                )

                if retry_count >= _CDN_500_MAX_RETRIES:
                    self.logger.warning(
                        "Max CDN 500 retries exceeded, skipping post permanently",
                        extra={
                            "job_id": self.job_id,
                            "post_id": post_id,
                            "service": service,
                            "creator_id": creator_id,
                            "retries": retry_count,
                        },
                    )
                    processed += 1
                    result.progress_pct = int(processed / total * 100) if total else 100
                    continue

                try:
                    scraped_post = await self._process_single_post(
                        client, service, creator_id, listing_post, headers,
                        creator_profiles, creator_s3_images,
                    )
                    # Successful retry — reset the consecutive-failure counter.
                    consecutive_500s = 0
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code == 500:
                        wait = min(
                            _CDN_500_INITIAL_DELAY * (2 ** consecutive_500s),
                            _CDN_500_MAX_DELAY,
                        )
                        consecutive_500s += 1
                        self.logger.warning(
                            "CDN still returning 500 on retry, backing off",
                            extra={
                                "job_id": self.job_id,
                                "post_id": post_id,
                                "retry_count": retry_count + 1,
                                "wait_seconds": wait,
                            },
                        )
                        if self.flush_callback:
                            await self.flush_callback(
                                [], [], self._last_flush_progress,
                                f"CDN error — waiting {wait:.0f}s before retry"
                                f" (attempt {retry_count + 1}/{_CDN_500_MAX_RETRIES})",
                            )
                        await asyncio.sleep(wait)
                        deferred_posts.append(
                            (retry_count + 1, service, creator_id, listing_post)
                        )
                        continue
                    raise

                if scraped_post is None:
                    processed += 1
                    result.progress_pct = int(processed / total * 100) if total else 100
                    continue

                processed += 1
                result.progress_pct = int(processed / total * 100) if total else 100
                self._last_flush_progress = result.progress_pct

                if self.flush_callback:
                    log_msg = (
                        f"Saved post {post_id} [{service}/{creator_id}]"
                        f" (attempt {retry_count + 2})"
                        f" ({processed}/{total}, {result.progress_pct}%)"
                    )
                    await self.flush_callback([scraped_post], [], result.progress_pct, log_msg)
                else:
                    result.posts.append(scraped_post)

                await asyncio.sleep(_POST_DELAY_SECONDS)

        if not result.posts and not self.flush_callback:
            result.progress_pct = 100

        self.logger.info(
            "Kemono scrape complete",
            extra={"job_id": self.job_id, "posts_count": len(result.posts)},
        )
        return result
