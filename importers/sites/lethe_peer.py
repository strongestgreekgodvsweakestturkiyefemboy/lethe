from __future__ import annotations

import asyncio
import re
from typing import Any

import httpx

from core.base_scraper import (
    BaseScraper,
    FlushCallback,
    ScrapeResult,
    ScrapedAttachment,
    ScrapedComment,
    ScrapedPost,
)

PAGE_SIZE = 50

# Back-off constants for rate-limited requests (mirrors kemono constants).
_RATE_LIMIT_INITIAL_DELAY = 60
_RATE_LIMIT_MAX_DELAY = 600
_RATE_LIMIT_MAX_RETRIES = 5

# Politeness delay (seconds) between individual creator fetches.
_CREATOR_DELAY = 0.25
# Politeness delay (seconds) between individual post-list page fetches.
_PAGE_DELAY = 0.1


def _validate_peer_url(raw: str) -> str:
    """Return the normalised peer URL or raise ``ValueError``.

    Accepted forms:
    * ``https://lethe.example.com``
    * ``http://localhost:3001``

    Trailing slashes are stripped.  Only http and https schemes are permitted.
    """
    raw = raw.strip().rstrip("/")
    if not re.match(r"^https?://", raw, re.IGNORECASE):
        raise ValueError(
            f"Invalid peer URL {raw!r}: must start with http:// or https://"
        )
    # Reject obviously invalid (e.g. whitespace inside URL)
    if " " in raw:
        raise ValueError(f"Invalid peer URL {raw!r}: contains whitespace")
    return raw


class LetheNodeScraper(BaseScraper):
    """Imports posts and media from another running Lethe instance.

    The ``session_token`` field is **not used for authentication** — the peer's
    public API requires no API key.  The token value should be the base URL of
    the remote Lethe backend (e.g. ``https://lethe.example.com``).

    Alternatively you can pass the peer URL via the ``peer_url`` constructor
    argument (used when instantiating from ``peerController``).  If *both* are
    provided, ``peer_url`` wins.

    The importer iterates over ``GET /api/v1/creators.json`` (paginated) and
    for each creator fetches ``GET /api/v1/creators/{service}/{id}/posts``
    (paginated), reconstructing the full post hierarchy — including attachments
    and comments — without requiring any credentials.
    """

    def __init__(
        self,
        session_token: str,
        job_id: str,
        peer_url: str = "",
        flush_callback: FlushCallback | None = None,
    ) -> None:
        super().__init__(session_token, job_id, flush_callback=flush_callback)
        # peer_url arg wins; fall back to session_token for backward compat.
        # When used via peerController, peer_url is populated directly.
        # When used via the legacy importController path, the URL is stored in
        # session_token (which is never a secret — it's just a URL here).
        raw_url = peer_url.strip() or session_token.strip()
        if not raw_url:
            raise ValueError(
                "LetheNodeScraper requires a peer URL. "
                "Provide it via the 'peer_url' constructor argument or the 'session_token' field."
            )
        self.peer_url = _validate_peer_url(raw_url)
        self._last_flush_progress: int = 0

    @property
    def site_name(self) -> str:
        return "lethe_peer"

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _get_json(
        self,
        client: httpx.AsyncClient,
        url: str,
        params: dict[str, Any] | None = None,
        *,
        context: str = "",
    ) -> dict[str, Any]:
        """Perform a GET request with rate-limit retry and return parsed JSON.

        Raises:
            RuntimeError: if the rate-limit retry budget is exhausted.
            httpx.HTTPStatusError: on non-2xx responses (after raising via
                ``raise_for_status``).
            ValueError: if the response body is not valid JSON.
        """
        delay = _RATE_LIMIT_INITIAL_DELAY
        last_exc: Exception | None = None

        for attempt in range(_RATE_LIMIT_MAX_RETRIES + 1):
            try:
                resp = await client.get(url, params=params)
            except httpx.RequestError as exc:
                last_exc = exc
                self.logger.warning(
                    "Network error fetching peer URL",
                    extra={
                        "job_id": self.job_id,
                        "url": url,
                        "context": context,
                        "error": str(exc),
                        "attempt": attempt + 1,
                    },
                )
                if attempt == _RATE_LIMIT_MAX_RETRIES:
                    raise RuntimeError(
                        f"Network error after {_RATE_LIMIT_MAX_RETRIES + 1} attempts"
                        f" fetching {url!r}: {exc}"
                    ) from exc
                await asyncio.sleep(min(delay, _RATE_LIMIT_MAX_DELAY))
                delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
                continue

            if resp.status_code == 429:
                if attempt == _RATE_LIMIT_MAX_RETRIES:
                    raise RuntimeError(
                        f"Rate limit reached fetching {url!r} after"
                        f" {_RATE_LIMIT_MAX_RETRIES + 1} attempts"
                    )
                self.logger.warning(
                    "Rate limited by peer — backing off",
                    extra={
                        "job_id": self.job_id,
                        "url": url,
                        "context": context,
                        "attempt": attempt + 1,
                        "wait_seconds": delay,
                    },
                )
                if self.flush_callback:
                    await self.flush_callback(
                        [],
                        [],
                        self._last_flush_progress,
                        f"Rate limited by peer — waiting {delay}s"
                        f" (attempt {attempt + 1}/{_RATE_LIMIT_MAX_RETRIES + 1})",
                    )
                await asyncio.sleep(delay)
                delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
                continue

            # Surface unexpected HTTP errors immediately.
            if resp.status_code not in (200,):
                self.logger.warning(
                    "Unexpected HTTP status from peer",
                    extra={
                        "job_id": self.job_id,
                        "url": url,
                        "context": context,
                        "status": resp.status_code,
                    },
                )
            resp.raise_for_status()

            try:
                return resp.json()
            except Exception as exc:
                raise ValueError(
                    f"Peer returned non-JSON body from {url!r}: {exc}"
                ) from exc

        # Should never be reached, but satisfies the type checker.
        if last_exc:
            raise RuntimeError(f"Failed to fetch {url!r}") from last_exc
        raise RuntimeError(f"Failed to fetch {url!r}")

    async def _fetch_all_creators(
        self,
        client: httpx.AsyncClient,
    ) -> list[dict[str, Any]]:
        """Return all creator records from the peer's public API."""
        creators: list[dict[str, Any]] = []
        cursor: str | None = None
        page_num = 0

        while True:
            params: dict[str, Any] = {"limit": PAGE_SIZE}
            if cursor:
                params["cursor"] = cursor

            self.logger.debug(
                "Fetching creators page",
                extra={"job_id": self.job_id, "peer_url": self.peer_url, "cursor": cursor},
            )

            data = await self._get_json(
                client,
                f"{self.peer_url}/api/v1/creators.json",
                params,
                context="list_creators",
            )

            page: list[dict[str, Any]] = data.get("creators") or []
            if not isinstance(page, list):
                self.logger.warning(
                    "Unexpected 'creators' field type from peer",
                    extra={"job_id": self.job_id, "type": type(page).__name__},
                )
                break

            creators.extend(page)
            page_num += 1
            self.logger.debug(
                "Received creators page",
                extra={
                    "job_id": self.job_id,
                    "page_num": page_num,
                    "page_size": len(page),
                    "total_so_far": len(creators),
                },
            )

            next_cursor: str | None = data.get("nextCursor")
            if not next_cursor:
                break
            cursor = next_cursor
            await asyncio.sleep(_PAGE_DELAY)

        return creators

    async def _fetch_creator_posts(
        self,
        client: httpx.AsyncClient,
        service: str,
        creator_external_id: str,
    ) -> list[dict[str, Any]]:
        """Return all posts for a single creator from the peer's public API."""
        posts: list[dict[str, Any]] = []
        cursor: str | None = None
        url = (
            f"{self.peer_url}/api/v1/creators"
            f"/{service}/{creator_external_id}/posts"
        )

        while True:
            params: dict[str, Any] = {"limit": PAGE_SIZE}
            if cursor:
                params["cursor"] = cursor

            try:
                data = await self._get_json(
                    client,
                    url,
                    params,
                    context=f"list_posts:{service}/{creator_external_id}",
                )
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code == 404:
                    # Creator may have been removed from peer between list and fetch.
                    self.logger.warning(
                        "Creator not found on peer during post fetch",
                        extra={
                            "job_id": self.job_id,
                            "service": service,
                            "creator_external_id": creator_external_id,
                        },
                    )
                    return []
                raise

            page: list[dict[str, Any]] = data.get("posts") or []
            if not isinstance(page, list):
                self.logger.warning(
                    "Unexpected 'posts' field type from peer",
                    extra={
                        "job_id": self.job_id,
                        "type": type(page).__name__,
                        "creator_external_id": creator_external_id,
                    },
                )
                break

            posts.extend(page)

            next_cursor: str | None = data.get("nextCursor")
            if not next_cursor:
                break
            cursor = next_cursor
            await asyncio.sleep(_PAGE_DELAY)

        return posts

    @staticmethod
    def _parse_post(raw: dict[str, Any], creator: dict[str, Any]) -> ScrapedPost | None:
        """Convert a raw post dict from the peer API into a ``ScrapedPost``.

        Returns ``None`` if the post is missing required fields.
        """
        external_id = str(raw.get("externalId") or "").strip()
        if not external_id:
            return None

        service_type = str(creator.get("serviceType") or "").strip()
        creator_external_id = str(creator.get("externalId") or "").strip()
        if not service_type or not creator_external_id:
            return None

        # Current title/content from the latest revision (revisionExternalId IS NULL).
        revisions: list[dict[str, Any]] = raw.get("revisions") or []
        title: str | None = None
        content: str | None = None
        for rev in revisions:
            if isinstance(rev, dict):
                title = rev.get("title") or title
                content = rev.get("content") or content
                # First entry is the current revision (ordered by id desc).
                break

        attachments: list[ScrapedAttachment] = []
        for att in raw.get("attachments") or []:
            if not isinstance(att, dict):
                continue
            file_url = str(att.get("fileUrl") or "").strip()
            if not file_url:
                continue
            data_type = str(att.get("dataType") or "FILE").strip()
            attachments.append(
                ScrapedAttachment(
                    file_url=file_url,
                    data_type=data_type,
                    name=att.get("name") or None,
                )
            )

        comments: list[ScrapedComment] = []
        for c in raw.get("comments") or []:
            if not isinstance(c, dict):
                continue
            c_ext_id = str(c.get("externalId") or "").strip()
            if not c_ext_id:
                continue
            # Resolve comment content from its nested revisions list.
            c_revisions: list[dict[str, Any]] = c.get("revisions") or []
            c_content = ""
            for cr in c_revisions:
                if isinstance(cr, dict) and cr.get("content"):
                    c_content = str(cr.get("content", ""))
                    break
            comments.append(
                ScrapedComment(
                    external_id=c_ext_id,
                    content=c_content,
                    author_name=c.get("authorName") or None,
                    published_at=c.get("publishedAt") or None,
                )
            )

        tags: list[str] = []
        for tag_entry in raw.get("tags") or []:
            if not isinstance(tag_entry, dict):
                continue
            tag = tag_entry.get("tag") or {}
            if isinstance(tag, dict) and tag.get("name"):
                tags.append(str(tag["name"]))

        return ScrapedPost(
            external_id=external_id,
            creator_external_id=creator_external_id,
            service_type=service_type,
            title=title,
            content=content,
            published_at=raw.get("publishedAt") or None,
            attachments=attachments,
            comments=comments,
            creator_name=creator.get("name") or None,
            creator_thumbnail_url=creator.get("thumbnailUrl") or None,
            creator_banner_url=creator.get("bannerUrl") or None,
            tags=tags,
        )

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def scrape(self) -> ScrapeResult:
        self.logger.info(
            "Starting peer import via public API",
            extra={"job_id": self.job_id, "peer_url": self.peer_url},
        )

        all_posts: list[ScrapedPost] = []
        flushed = 0
        total_posts_imported = 0

        async with httpx.AsyncClient(timeout=60) as client:
            # -------------------------------------------------------
            # 1. Enumerate all creators on the peer node.
            # -------------------------------------------------------
            try:
                creators = await self._fetch_all_creators(client)
            except Exception as exc:
                msg = f"Failed to list creators from peer: {exc}"
                self.logger.error(
                    msg,
                    extra={"job_id": self.job_id, "peer_url": self.peer_url},
                )
                return ScrapeResult(error=msg)

            total_creators = len(creators)
            self.logger.info(
                "Found creators on peer",
                extra={
                    "job_id": self.job_id,
                    "peer_url": self.peer_url,
                    "total_creators": total_creators,
                },
            )

            if total_creators == 0:
                self.logger.info(
                    "Peer has no creators — nothing to import",
                    extra={"job_id": self.job_id},
                )
                return ScrapeResult(progress_pct=100)

            # -------------------------------------------------------
            # 2. For each creator, fetch all their posts.
            # -------------------------------------------------------
            for c_idx, creator in enumerate(creators):
                if not isinstance(creator, dict):
                    self.logger.warning(
                        "Skipping non-dict creator entry",
                        extra={"job_id": self.job_id, "creator": creator},
                    )
                    continue

                service = str(creator.get("serviceType") or "").strip()
                creator_external_id = str(creator.get("externalId") or "").strip()

                if not service or not creator_external_id:
                    self.logger.warning(
                        "Skipping creator with missing serviceType or externalId",
                        extra={
                            "job_id": self.job_id,
                            "creator_id": creator.get("id"),
                        },
                    )
                    continue

                self.logger.debug(
                    "Fetching posts for creator",
                    extra={
                        "job_id": self.job_id,
                        "service": service,
                        "creator_external_id": creator_external_id,
                        "creator_name": creator.get("name"),
                    },
                )

                try:
                    raw_posts = await self._fetch_creator_posts(
                        client, service, creator_external_id
                    )
                except Exception as exc:
                    self.logger.warning(
                        "Error fetching posts for creator — skipping",
                        extra={
                            "job_id": self.job_id,
                            "service": service,
                            "creator_external_id": creator_external_id,
                            "error": str(exc),
                        },
                    )
                    continue

                batch: list[ScrapedPost] = []
                for raw_post in raw_posts:
                    try:
                        post = self._parse_post(raw_post, creator)
                    except Exception as exc:
                        self.logger.warning(
                            "Failed to parse post — skipping",
                            extra={
                                "job_id": self.job_id,
                                "service": service,
                                "creator_external_id": creator_external_id,
                                "error": str(exc),
                            },
                        )
                        continue

                    if post is None:
                        self.logger.debug(
                            "Skipping post with missing required fields",
                            extra={"job_id": self.job_id, "raw": raw_post},
                        )
                        continue

                    batch.append(post)

                total_posts_imported += len(batch)
                all_posts.extend(batch)

                overall_progress = int((c_idx + 1) / max(total_creators, 1) * 100)
                self._last_flush_progress = overall_progress

                if self.flush_callback and batch:
                    log_msg = (
                        f"Creator {c_idx + 1}/{total_creators}"
                        f" ({creator.get('name') or creator_external_id}):"
                        f" {len(batch)} posts (total so far: {total_posts_imported})"
                    )
                    await self.flush_callback(
                        all_posts[flushed:], [], overall_progress, log_msg
                    )
                    flushed = len(all_posts)

                await asyncio.sleep(_CREATOR_DELAY)

        self.logger.info(
            "Peer import complete",
            extra={
                "job_id": self.job_id,
                "peer_url": self.peer_url,
                "total_creators": total_creators,
                "total_posts_imported": total_posts_imported,
            },
        )
        return ScrapeResult(
            posts=all_posts[flushed:],
            items=[],
            progress_pct=100,
        )
