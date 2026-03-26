from __future__ import annotations

import asyncio
from typing import Any

import httpx

from core.base_scraper import BaseScraper, FlushCallback, ScrapeResult, ScrapedItem

PAGE_SIZE = 50

# Back-off constants for rate-limited peer exports (mirrors kemono constants)
_RATE_LIMIT_INITIAL_DELAY = 60
_RATE_LIMIT_MAX_DELAY = 600
_RATE_LIMIT_MAX_RETRIES = 5


class LetheNodeScraper(BaseScraper):
    """Imports DataItems from another running Lethe instance via its export API.

    The ``session_token`` field carries the remote node's export API key.
    The ``peer_url`` is the base URL of the remote Lethe backend.
    """

    def __init__(
        self,
        session_token: str,
        job_id: str,
        peer_url: str,
        flush_callback: FlushCallback | None = None,
    ) -> None:
        super().__init__(session_token, job_id, flush_callback=flush_callback)
        self.peer_url = peer_url.rstrip("/")
        self._last_flush_progress: int = 0

    @property
    def site_name(self) -> str:
        return "lethe_peer"

    async def scrape(self) -> ScrapeResult:
        self.logger.info(
            "Starting peer import",
            extra={"job_id": self.job_id, "peer_url": self.peer_url},
        )
        result = ScrapeResult()
        cursor: str | None = None
        page_num = 0
        total_imported = 0

        async with httpx.AsyncClient(timeout=30) as client:
            while True:
                params: dict[str, Any] = {"limit": PAGE_SIZE}
                if cursor:
                    params["cursor"] = cursor

                self.logger.debug(
                    "Fetching export page",
                    extra={"job_id": self.job_id, "peer_url": self.peer_url, "cursor": cursor},
                )

                # Retry loop for rate limiting
                delay = _RATE_LIMIT_INITIAL_DELAY
                total_attempts = _RATE_LIMIT_MAX_RETRIES + 1
                response: httpx.Response | None = None
                for attempt in range(total_attempts):
                    response = await client.get(
                        f"{self.peer_url}/api/v1/export/items",
                        params=params,
                        headers={"x-api-key": self.session_token},
                    )
                    if response.status_code != 429:
                        break
                    if attempt == total_attempts - 1:
                        raise RuntimeError("rate limit reached fetching peer export")
                    self.logger.warning(
                        "Rate limited on peer export, backing off",
                        extra={
                            "job_id": self.job_id,
                            "peer_url": self.peer_url,
                            "attempt": attempt + 1,
                            "total_attempts": total_attempts,
                            "wait_seconds": delay,
                        },
                    )
                    if self.flush_callback:
                        await self.flush_callback(
                            [], [], self._last_flush_progress,
                            f"Rate limited by peer — waiting {delay}s before retry"
                            f" (attempt {attempt + 1}/{total_attempts})",
                        )
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)

                assert response is not None
                response.raise_for_status()
                data: dict[str, Any] = response.json()
                page_items: list[dict[str, Any]] = data.get("items", [])

                self.logger.debug(
                    "Received export page",
                    extra={"job_id": self.job_id, "page_size": len(page_items)},
                )

                if page_items:
                    items_batch = [
                        ScrapedItem(
                            data_type=item.get("dataType", "TEXT"),
                            content=item.get("content"),
                            file_url=item.get("fileUrl"),
                        )
                        for item in page_items
                    ]
                    total_imported += len(items_batch)
                    page_num += 1

                    if self.flush_callback:
                        log_msg = (
                            f"Imported page {page_num}: {len(items_batch)} items"
                            f" (total so far: {total_imported})"
                        )
                        await self.flush_callback([], items_batch, 0, log_msg)
                    else:
                        result.items.extend(items_batch)

                next_cursor: str | None = data.get("nextCursor")
                if not next_cursor:
                    break
                cursor = next_cursor
                await asyncio.sleep(0.1)  # be polite to the peer

        result.progress_pct = 100
        self.logger.info(
            "Peer import complete",
            extra={"job_id": self.job_id, "total_imported": total_imported},
        )
        return result
