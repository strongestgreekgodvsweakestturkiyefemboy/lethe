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

_API_BASE = "https://discord.com/api/v10"

_RATE_LIMIT_INITIAL_DELAY = 10   # Discord 429 headers usually have retry_after
_RATE_LIMIT_MAX_DELAY = 300
_RATE_LIMIT_MAX_RETRIES = 5
_POST_DELAY: float = float(os.environ.get("POST_DELAY_SECONDS", "0.5"))

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


class DiscordScraper(BaseScraper):
    """Archives messages and attachments from Discord channels.

    Token formats (one of):
    * ``{token}:{channel_id}`` — archive a specific channel.
    * ``{token}:{guild_id}/{channel_id}`` — archive a specific channel within a
      guild (server), identical to the above in terms of behaviour.
    * ``{token}`` alone — archive all accessible DM channels for the account.

    ``{token}`` is a Discord user token (visible in browser developer tools) or
    a bot token prefixed with ``Bot `` (e.g. ``Bot MTxxxxx``).

    .. warning::
        Using self-bots (user tokens) violates Discord's Terms of Service.
        Use bot tokens wherever possible.

    ``external_id`` is the Discord message ID (snowflake),
    ``creator_external_id`` is the channel ID, and ``service_type`` is
    ``"discord"`` to match Kemono records.
    """

    @property
    def site_name(self) -> str:
        return "discord"

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _parse_token(self) -> tuple[str, str | None]:
        """Return ``(discord_token, channel_id_or_None)``."""
        token = self.session_token.strip()

        # token:channel_id or token:guild_id/channel_id
        # Safely split: the token itself may contain periods but no colons
        # unless it is a Bot token ("Bot XYZ")
        # Strategy: split at the LAST colon that's followed by only digits or digits/digits
        m = re.match(r"^(.*):(\d+(?:/\d+)?)$", token)
        if m:
            raw_token = m.group(1)
            channel_part = m.group(2)
            # channel_id is the last component
            channel_id = channel_part.split("/")[-1]
            return raw_token, channel_id

        return token, None

    def _base_headers(self, token: str) -> dict[str, str]:
        return {
            "Authorization": token,
            "Accept": "application/json",
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
        }

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
                raise RuntimeError("rate limit reached on discord.com")
            # Respect Discord's retry_after if provided
            try:
                retry_after = float(resp.json().get("retry_after", delay))
            except Exception:
                retry_after = delay
            wait = min(retry_after, _RATE_LIMIT_MAX_DELAY)
            self.logger.warning(
                "Rate limited by Discord",
                extra={"job_id": self.job_id, "wait": wait},
            )
            if self.flush_callback:
                await self.flush_callback([], [], 0, f"Rate limited — waiting {wait:.1f}s")
            await asyncio.sleep(wait)
            delay = min(delay * 2, _RATE_LIMIT_MAX_DELAY)
        raise RuntimeError("rate limit reached on discord.com")

    async def _fetch_dm_channels(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        resp = await self._get(client, f"{_API_BASE}/users/@me/channels", headers)
        if resp.status_code == 401:
            raise ValueError("Invalid Discord token — please check your credentials.")
        resp.raise_for_status()
        channels = resp.json()
        return [c for c in channels if isinstance(c, dict) and c.get("type") in (1, 3)]

    async def _fetch_channel_messages(
        self,
        client: httpx.AsyncClient,
        channel_id: str,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        before: str | None = None
        limit = 100
        while True:
            params: dict[str, Any] = {"limit": limit}
            if before:
                params["before"] = before
            resp = await self._get(
                client,
                f"{_API_BASE}/channels/{channel_id}/messages",
                headers,
                params,
            )
            if resp.status_code in (403, 404):
                self.logger.warning(
                    "Cannot access Discord channel",
                    extra={"job_id": self.job_id, "channel_id": channel_id, "status": resp.status_code},
                )
                break
            resp.raise_for_status()
            batch: list[dict[str, Any]] = resp.json()
            if not batch:
                break
            messages.extend(batch)
            if len(batch) < limit:
                break
            before = batch[-1]["id"]
            await asyncio.sleep(_POST_DELAY)
        return messages

    async def _stream(self, url: str, headers: dict[str, str], name: str | None = None) -> ScrapedAttachment | None:
        try:
            s3_key = await stream_url_to_s3(url, headers, "discord")
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
        token, channel_id = self._parse_token()
        headers = self._base_headers(token)

        all_posts: list[ScrapedPost] = []
        flushed = 0

        async with httpx.AsyncClient(timeout=60) as client:
            if channel_id:
                channel_ids = [channel_id]
            else:
                self.logger.info("Fetching Discord DM channels", extra={"job_id": self.job_id})
                dm_channels = await self._fetch_dm_channels(client, headers)
                channel_ids = [str(c["id"]) for c in dm_channels if c.get("id")]
                self.logger.info(
                    "Found DM channels",
                    extra={"job_id": self.job_id, "count": len(channel_ids)},
                )

            for c_idx, cid in enumerate(channel_ids):
                self.logger.info(
                    "Fetching Discord channel messages",
                    extra={"job_id": self.job_id, "channel_id": cid},
                )
                messages = await self._fetch_channel_messages(client, cid, headers)
                total = len(messages)
                n_channels = max(len(channel_ids), 1)

                for idx, msg in enumerate(messages):
                    mid = str(msg.get("id") or "")
                    if not mid:
                        continue

                    author = msg.get("author") or {}
                    author_name = author.get("global_name") or author.get("username") or ""
                    author_id = str(author.get("id") or "")
                    content = msg.get("content") or ""
                    ts = msg.get("timestamp")

                    attachments: list[ScrapedAttachment] = []
                    for att_data in msg.get("attachments") or []:
                        url = att_data.get("url") or att_data.get("proxy_url")
                        name = att_data.get("filename")
                        if url:
                            att = await self._stream(url, headers, name)
                            if att:
                                attachments.append(att)

                    # Embed images
                    for embed in msg.get("embeds") or []:
                        img = embed.get("image") or embed.get("thumbnail")
                        if img and img.get("url"):
                            att = await self._stream(img["url"], headers)
                            if att:
                                att.data_type = "IMAGE"
                                attachments.append(att)

                    # Referenced message as thread context
                    comments: list[ScrapedComment] = []
                    ref = msg.get("referenced_message")
                    if ref and ref.get("id"):
                        ref_author = ref.get("author") or {}
                        comments.append(
                            ScrapedComment(
                                external_id=str(ref["id"]),
                                content=ref.get("content") or "",
                                author_name=ref_author.get("global_name") or ref_author.get("username"),
                                published_at=ref.get("timestamp"),
                            )
                        )

                    post = ScrapedPost(
                        external_id=mid,
                        creator_external_id=cid,
                        service_type="discord",
                        title=None,
                        content=content or None,
                        published_at=ts,
                        attachments=attachments,
                        comments=comments,
                        creator_name=author_name or None,
                    )
                    all_posts.append(post)

                    overall_progress = int(
                        (c_idx / n_channels + (idx + 1) / (total * n_channels)) * 100
                    )
                    if self.flush_callback and (idx + 1) % 20 == 0:
                        await self.flush_callback(
                            all_posts[flushed:], [], overall_progress,
                            f"Channel {c_idx + 1}/{len(channel_ids)}: "
                            f"processed {idx + 1}/{total} messages",
                        )
                        flushed = len(all_posts)

                    await asyncio.sleep(_POST_DELAY)

        return ScrapeResult(posts=all_posts[flushed:], items=[], progress_pct=100)
