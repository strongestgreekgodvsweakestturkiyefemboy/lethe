from __future__ import annotations

import abc
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from core.logger import get_logger


@dataclass
class ScrapedItem:
    data_type: str  # TEXT | IMAGE | VIDEO | AUDIO | FILE
    content: str | None = None
    file_url: str | None = None
    source_post_id: str | None = None
    published_at: str | None = None  # ISO-8601 datetime string
    source_site: str | None = None  # overrides the job's targetSite when set


@dataclass
class ScrapedAttachment:
    """A file attached to a post (image, video, audio, or other file)."""

    file_url: str  # S3 object key after upload
    data_type: str  # IMAGE | VIDEO | AUDIO | FILE
    name: str | None = None  # original filename


@dataclass
class ScrapedComment:
    """A comment on a post."""

    external_id: str  # comment ID on the source platform
    content: str
    author_name: str | None = None
    published_at: str | None = None  # ISO-8601 datetime string


@dataclass
class ScrapedPostRevision:
    """A historical revision of a post's content (from the source platform)."""

    title: str | None = None
    content: str | None = None
    published_at: str | None = None  # ISO-8601 datetime string
    revision_external_id: str | None = None  # platform revision ID, used for dedup


@dataclass
class ScrapedPost:
    """A post (or announcement) by a creator, with optional attachments and comments."""

    external_id: str  # post ID on the source platform
    creator_external_id: str  # creator/user ID on the source platform
    service_type: str  # platform name, e.g. "patreon", "fanbox"
    title: str | None = None
    content: str | None = None
    published_at: str | None = None  # ISO-8601 datetime string
    attachments: list[ScrapedAttachment] = field(default_factory=list)
    comments: list[ScrapedComment] = field(default_factory=list)
    # Historical revisions from the source platform (stored as PostRevision rows,
    # NOT as separate Post records).  Ordered oldest-first so the current title/
    # content ends up as the last-written (highest-ID) revision.
    historical_revisions: list[ScrapedPostRevision] = field(default_factory=list)
    creator_name: str | None = None  # display name fetched from the source platform
    creator_thumbnail_url: str | None = None  # avatar S3 key (or external URL fallback)
    creator_banner_url: str | None = None  # banner/header S3 key


@dataclass
class ScrapeResult:
    items: list[ScrapedItem] = field(default_factory=list)
    posts: list[ScrapedPost] = field(default_factory=list)
    progress_pct: int = 0
    error: str | None = None
    log_message: str | None = None


# Async callback invoked by scrapers to stream partial results to the backend.
# Arguments: (posts, items, progress_pct, log_message)
FlushCallback = Callable[
    [list[ScrapedPost], list[ScrapedItem], int, str | None],
    Awaitable[None],
]


class BaseScraper(abc.ABC):
    """Strategy base class for all site-specific scrapers."""

    def __init__(
        self,
        session_token: str,
        job_id: str,
        flush_callback: FlushCallback | None = None,
    ) -> None:
        self.session_token = session_token
        self.job_id = job_id
        self.flush_callback = flush_callback
        self.logger = get_logger(f"scraper.{self.site_name}")

    @abc.abstractmethod
    async def scrape(self) -> ScrapeResult:
        """Execute the full scrape and return results.

        Scrapers that support streaming should call ``self.flush_callback``
        periodically with partial data so that results are persisted
        incrementally rather than all at once at the end.
        """
        ...

    @property
    @abc.abstractmethod
    def site_name(self) -> str:
        """Return the canonical site identifier."""
        ...
