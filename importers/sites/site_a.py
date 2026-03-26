from __future__ import annotations

import asyncio

from core.base_scraper import BaseScraper, ScrapeResult, ScrapedItem


class SiteAScraper(BaseScraper):
    """Dummy scraper for 'site_a' — used to test the queue and webhook flow."""

    @property
    def site_name(self) -> str:
        return "site_a"

    async def scrape(self) -> ScrapeResult:
        self.logger.info("Starting site_a dummy scrape", extra={"job_id": self.job_id})
        result = ScrapeResult()
        for i in range(1, 6):
            await asyncio.sleep(0.5)
            result.items.append(
                ScrapedItem(
                    data_type="TEXT",
                    content=f"[site_a] Dummy item {i} from job {self.job_id}",
                )
            )
            result.progress_pct = i * 20
            self.logger.debug(
                "site_a progress",
                extra={"job_id": self.job_id, "progress_pct": result.progress_pct, "item_index": i},
            )
        self.logger.info(
            "site_a scrape complete",
            extra={"job_id": self.job_id, "items_count": len(result.items)},
        )
        return result
