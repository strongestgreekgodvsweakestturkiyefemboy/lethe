from __future__ import annotations

import asyncio
import os
import sys

import httpx
from bullmq import Worker
from bullmq.job import Job
from dotenv import load_dotenv

load_dotenv()

# Add importers directory to path so core/sites are importable
sys.path.insert(0, os.path.dirname(__file__))

from core.base_scraper import FlushCallback, ScrapedItem, ScrapedPost
from core.crypto import decrypt_token
from core.logger import get_logger
from sites.site_a import SiteAScraper
from sites.lethe_peer import LetheNodeScraper
from sites.kemono import KemonoScraper
from sites.patreon import PatreonScraper
from sites.fanbox import FanboxScraper
from sites.gumroad import GumroadScraper
from sites.subscribestar import SubscribeStarScraper
from sites.onlyfans import OnlyFansScraper
from sites.fansly import FanslyScraper
from sites.boosty import BoostyScraper
from sites.dlsite import DLsiteScraper
from sites.discord import DiscordScraper
from sites.fantia import FantiaScraper

logger = get_logger("main")

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:3001")
INTERNAL_SECRET = os.environ.get("INTERNAL_WEBHOOK_SECRET", "super-secret-internal-key")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")

SCRAPER_REGISTRY: dict[str, type] = {
    "site_a": SiteAScraper,
    "lethe_peer": LetheNodeScraper,
    "kemono": KemonoScraper,
    "patreon": PatreonScraper,
    "fanbox": FanboxScraper,
    "gumroad": GumroadScraper,
    "subscribestar": SubscribeStarScraper,
    "onlyfans": OnlyFansScraper,
    "fansly": FanslyScraper,
    "boosty": BoostyScraper,
    "dlsite": DLsiteScraper,
    "discord": DiscordScraper,
    "fantia": FantiaScraper,
}


def _serialize_item(item: ScrapedItem) -> dict:
    return {
        "dataType": item.data_type,
        "content": item.content,
        "fileUrl": item.file_url,
        "sourcePostId": item.source_post_id,
        "publishedAt": item.published_at,
        "sourceSite": item.source_site,
    }


def _serialize_post(post: ScrapedPost) -> dict:
    return {
        "externalId": post.external_id,
        "creatorExternalId": post.creator_external_id,
        "serviceType": post.service_type,
        "title": post.title,
        "content": post.content,
        "publishedAt": post.published_at,
        "creatorName": post.creator_name,
        "creatorThumbnailUrl": post.creator_thumbnail_url,
        "creatorBannerUrl": post.creator_banner_url,
        "discordAuthorId": post.discord_author_id,
        "discordGuildId": post.discord_guild_id,
        "discordAuthorInfo": post.discord_author_info,
        "attachments": [
            {
                "fileUrl": att.file_url,
                "dataType": att.data_type,
                "name": att.name,
            }
            for att in post.attachments
        ],
        "comments": [
            {
                "externalId": c.external_id,
                "content": c.content,
                "authorName": c.author_name,
                "publishedAt": c.published_at,
            }
            for c in post.comments
        ],
        "historicalRevisions": [
            {
                "title": r.title,
                "content": r.content,
                "publishedAt": r.published_at,
                "revisionExternalId": r.revision_external_id,
            }
            for r in post.historical_revisions
        ],
        "tags": post.tags,
    }


async def _post_update(
    job_id: str,
    status: str,
    progress_pct: int,
    new_items: list[dict] | None = None,
    new_posts: list[dict] | None = None,
    log_message: str | None = None,
    discord_server_info: dict | None = None,
) -> None:
    payload: dict = {"status": status, "progressPct": progress_pct}
    if new_items:
        payload["newItems"] = new_items
    if new_posts:
        payload["newPosts"] = new_posts
    if log_message:
        payload["logMessage"] = log_message
    if discord_server_info:
        payload["discordServerInfo"] = discord_server_info
    logger.debug(
        "Posting job update to backend",
        extra={
            "job_id": job_id,
            "status": status,
            "progress_pct": progress_pct,
            "new_items_count": len(new_items) if new_items else 0,
            "new_posts_count": len(new_posts) if new_posts else 0,
        },
    )
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BACKEND_URL}/api/internal/jobs/{job_id}/update",
            json=payload,
            headers={"x-internal-secret": INTERNAL_SECRET},
            timeout=10,
        )
    logger.debug(
        "Backend webhook response",
        extra={"job_id": job_id, "status_code": resp.status_code},
    )


def _make_flush_callback(job_id: str) -> FlushCallback:
    """Return an async callback that streams partial scraper results to the backend."""

    async def _flush(
        posts: list[ScrapedPost],
        items: list[ScrapedItem],
        progress_pct: int,
        log_message: str | None = None,
        discord_server_info: dict | None = None,
    ) -> None:
        serialized_posts = [_serialize_post(p) for p in posts] or None
        serialized_items = [_serialize_item(i) for i in items] or None
        await _post_update(
            job_id,
            "IN_PROGRESS",
            progress_pct,
            serialized_items,
            serialized_posts,
            log_message,
            discord_server_info,
        )

    return _flush


async def process_import(job: Job, job_token: str) -> None:
    data = job.data
    job_id: str = data["jobId"]
    target_site: str = data["targetSite"]
    encrypted_token: str = data["encryptedToken"]
    peer_url: str | None = data.get("peerUrl")

    logger.info("Processing import job", extra={"job_id": job_id, "target_site": target_site})

    try:
        logger.debug("Decrypting session token", extra={"job_id": job_id})
        session_token = decrypt_token(encrypted_token)
        logger.debug("Session token decrypted successfully", extra={"job_id": job_id})
    except Exception as exc:
        logger.error(
            "Failed to decrypt session token",
            extra={"job_id": job_id, "error": str(exc)},
            exc_info=True,
        )
        await _post_update(job_id, "FAILED", 0)
        raise exc

    await _post_update(job_id, "IN_PROGRESS", 0)

    ScraperClass = SCRAPER_REGISTRY.get(target_site)
    if not ScraperClass:
        logger.error(
            "No scraper registered for site",
            extra={"job_id": job_id, "target_site": target_site},
        )
        await _post_update(job_id, "FAILED", 0)
        raise ValueError(f"No scraper registered for site: {target_site}")

    logger.info(
        "Instantiating scraper",
        extra={"job_id": job_id, "target_site": target_site, "scraper": ScraperClass.__name__},
    )

    flush_cb = _make_flush_callback(job_id)

    # LetheNodeScraper requires an extra peer_url kwarg
    if target_site == "lethe_peer":
        if not peer_url:
            logger.error("peerUrl missing for lethe_peer job", extra={"job_id": job_id})
            await _post_update(job_id, "FAILED", 0)
            raise ValueError("peerUrl is required for lethe_peer jobs")
        scraper = ScraperClass(
            session_token=session_token,
            job_id=job_id,
            peer_url=peer_url,
            flush_callback=flush_cb,
        )
    else:
        scraper = ScraperClass(
            session_token=session_token,
            job_id=job_id,
            flush_callback=flush_cb,
        )

    try:
        logger.info("Starting scrape", extra={"job_id": job_id, "target_site": target_site})
        result = await scraper.scrape()
        logger.info(
            "Scrape finished",
            extra={
                "job_id": job_id,
                "target_site": target_site,
                "items_count": len(result.items),
                "posts_count": len(result.posts),
                "progress_pct": result.progress_pct,
                "error": result.error,
            },
        )

        # Serialize any remaining data not yet flushed by the scraper
        remaining_items = [_serialize_item(i) for i in result.items] or None
        remaining_posts = [_serialize_post(p) for p in result.posts] or None

        if result.error:
            logger.warning(
                "Scrape completed with error",
                extra={"job_id": job_id, "scrape_error": result.error},
            )
            await _post_update(
                job_id, "FAILED", result.progress_pct,
                remaining_items, remaining_posts,
                discord_server_info=result.discord_server_info,
            )
        else:
            logger.info(
                "Scrape completed successfully",
                extra={
                    "job_id": job_id,
                    "remaining_items": len(result.items),
                    "remaining_posts": len(result.posts),
                },
            )
            await _post_update(
                job_id, "COMPLETED", 100,
                remaining_items, remaining_posts,
                discord_server_info=result.discord_server_info,
            )
    except Exception as exc:
        status = "FAILED_RATE_LIMIT" if "rate limit" in str(exc).lower() else "FAILED"
        logger.error(
            "Scrape raised exception",
            extra={"job_id": job_id, "target_site": target_site, "status": status, "error": str(exc)},
            exc_info=True,
        )
        await _post_update(job_id, status, 0)
        raise exc


def main() -> None:
    async def _run() -> None:
        async def handler(job: Job, job_token: str) -> None:
            await process_import(job, job_token)

        logger.info(
            "Worker starting",
            extra={"redis_url": REDIS_URL, "backend_url": BACKEND_URL},
        )
        worker = Worker("imports", handler, {"connection": REDIS_URL,
                                             "prefix": "bullmq",
                                            })
        logger.info("Worker started. Waiting for jobs…")
        await asyncio.Future()  # run forever

    asyncio.run(_run())


if __name__ == "__main__":
    main()
