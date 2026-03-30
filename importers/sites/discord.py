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

_DISCORD_CDN = "https://cdn.discordapp.com"


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
    * ``{token}:{guild_id}/`` — archive all text channels in a guild (trailing slash).
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

    def _parse_token(self) -> tuple[str, str | None, str | None]:
        """Return ``(discord_token, guild_id_or_None, channel_id_or_None)``.

        Supported formats:
        * ``{token}:{channel_id}`` — archive a specific non-guild channel.
        * ``{token}:{guild_id}/{channel_id}`` — archive a specific channel in a guild.
        * ``{token}:{guild_id}/`` — archive all text channels in a guild (trailing slash).
        """
        token = self.session_token.strip()

        # token:guild_id/channel_id  or  token:guild_id/  (trailing slash → whole guild)
        m = re.match(r"^(.*):(\d+)/(\d*)$", token)
        if m:
            raw_token = m.group(1)
            guild_id = m.group(2)
            channel_id = m.group(3) or None  # empty string after slash → whole guild
            return raw_token, guild_id, channel_id

        # token:channel_id  (no guild prefix)
        m = re.match(r"^(.*):(\d+)$", token)
        if m:
            raw_token = m.group(1)
            channel_id = m.group(2)
            return raw_token, None, channel_id

        # No channel specified — falls back to DM channel archiving in scrape()
        return token, None, None

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

    async def _fetch_guild_info(
        self,
        client: httpx.AsyncClient,
        guild_id: str,
        headers: dict[str, str],
    ) -> dict[str, Any]:
        """Return guild info including name, icon and roles."""
        resp = await self._get(client, f"{_API_BASE}/guilds/{guild_id}", headers)
        if resp.status_code == 401:
            raise ValueError("Invalid Discord token — please check your credentials.")
        if resp.status_code in (403, 404):
            self.logger.warning(
                "Could not fetch Discord guild info",
                extra={"job_id": self.job_id, "guild_id": guild_id, "status": resp.status_code},
            )
            return {}
        resp.raise_for_status()
        return resp.json()

    async def _fetch_guild_channels(
        self,
        client: httpx.AsyncClient,
        guild_id: str,
        headers: dict[str, str],
    ) -> list[dict[str, Any]]:
        """Return ALL channels in a guild (all types, for structure preservation)."""
        resp = await self._get(client, f"{_API_BASE}/guilds/{guild_id}/channels", headers)
        if resp.status_code == 401:
            raise ValueError("Invalid Discord token — please check your credentials.")
        if resp.status_code in (403, 404):
            raise ValueError(
                f"Cannot access guild {guild_id} — check bot permissions or guild ID."
            )
        resp.raise_for_status()
        channels = resp.json()
        return [c for c in channels if isinstance(c, dict) and c.get("id")]

    def _text_channels(self, channels: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Filter to only text (type 0) and announcement (type 5) channels."""
        return [c for c in channels if c.get("type") in (0, 5)]

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

    async def _fetch_channel_info(
        self,
        client: httpx.AsyncClient,
        channel_id: str,
        headers: dict[str, str],
    ) -> dict[str, Any]:
        """Return channel info dict from Discord API, or empty dict on error."""
        resp = await self._get(client, f"{_API_BASE}/channels/{channel_id}", headers)
        if resp.status_code in (401, 403, 404):
            self.logger.warning(
                "Could not fetch Discord channel info",
                extra={"job_id": self.job_id, "channel_id": channel_id, "status": resp.status_code},
            )
            return {}
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def _user_display_name(user: dict[str, Any]) -> str:
        """Return the best available display name for a Discord user dict."""
        return user.get("global_name") or user.get("username") or ""

    @staticmethod
    def _user_avatar_url(user_id: str, avatar_hash: str | None) -> str | None:
        """Return the CDN URL for a Discord user avatar, or None."""
        if not avatar_hash or not user_id:
            return None
        ext = "gif" if avatar_hash.startswith("a_") else "png"
        return f"{_DISCORD_CDN}/avatars/{user_id}/{avatar_hash}.{ext}"

    @staticmethod
    def _guild_icon_url(guild_id: str, icon_hash: str | None) -> str | None:
        if not icon_hash:
            return None
        ext = "gif" if icon_hash.startswith("a_") else "png"
        return f"{_DISCORD_CDN}/icons/{guild_id}/{icon_hash}.{ext}"

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
        discord_token, guild_id, channel_id = self._parse_token()
        headers = self._base_headers(discord_token)

        all_posts: list[ScrapedPost] = []
        flushed = 0

        # Maps channel_id → human-readable channel name used as creator_name.
        channel_names: dict[str, str] = {}

        # Discord server metadata to be returned with the result.
        discord_server_info: dict[str, Any] | None = None

        async with httpx.AsyncClient(timeout=60) as client:
            if guild_id and channel_id:
                # Specific channel within a guild — fetch guild info + all channels
                all_guild_channels = await self._fetch_guild_channels(client, guild_id, headers)
                for c in all_guild_channels:
                    if c.get("id"):
                        channel_names[str(c["id"])] = c.get("name") or f"channel-{c['id']}"
                channel_ids = [channel_id]

                guild_info = await self._fetch_guild_info(client, guild_id, headers)
                discord_server_info = self._build_server_info(guild_id, guild_info, all_guild_channels)

            elif guild_id and not channel_id:
                # Whole guild — archive all text/announcement channels
                self.logger.info(
                    "Fetching all text channels for Discord guild",
                    extra={"job_id": self.job_id, "guild_id": guild_id},
                )
                all_guild_channels = await self._fetch_guild_channels(client, guild_id, headers)
                text_channels = self._text_channels(all_guild_channels)
                channel_ids = [str(c["id"]) for c in text_channels if c.get("id")]
                channel_names = {
                    str(c["id"]): c.get("name") or f"channel-{c['id']}"
                    for c in all_guild_channels
                    if c.get("id")
                }
                self.logger.info(
                    "Found guild text channels",
                    extra={"job_id": self.job_id, "count": len(channel_ids)},
                )
                guild_info = await self._fetch_guild_info(client, guild_id, headers)
                discord_server_info = self._build_server_info(guild_id, guild_info, all_guild_channels)

            elif channel_id:
                # Specific non-guild channel
                channel_ids = [channel_id]
                info = await self._fetch_channel_info(client, channel_id, headers)
                channel_names[channel_id] = info.get("name") or f"channel-{channel_id}"
                # Check if this channel belongs to a guild
                if info.get("guild_id"):
                    g_id = str(info["guild_id"])
                    all_guild_channels = await self._fetch_guild_channels(client, g_id, headers)
                    for c in all_guild_channels:
                        if c.get("id"):
                            channel_names[str(c["id"])] = c.get("name") or f"channel-{c['id']}"
                    guild_info = await self._fetch_guild_info(client, g_id, headers)
                    discord_server_info = self._build_server_info(g_id, guild_info, all_guild_channels)
                    guild_id = g_id
            else:
                # No channel specified — archive accessible DM channels
                self.logger.info("Fetching Discord DM channels", extra={"job_id": self.job_id})
                dm_channels = await self._fetch_dm_channels(client, headers)
                channel_ids = [str(c["id"]) for c in dm_channels if c.get("id")]
                for c in dm_channels:
                    if not c.get("id"):
                        continue
                    cid_str = str(c["id"])
                    recipients = c.get("recipients") or []
                    names = [self._user_display_name(r) for r in recipients]
                    channel_names[cid_str] = (
                        ", ".join(n for n in names if n) or f"dm-{cid_str}"
                    )
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

                    try:
                        author = msg.get("author") or {}
                        author_id = str(author.get("id") or "") or None
                        author_name = self._user_display_name(author)
                        content = msg.get("content") or ""
                        ts = msg.get("timestamp")

                        # Build structured author info for DiscordUser upsert
                        discord_author_info: dict[str, Any] | None = None
                        if author_id:
                            discord_author_info = {
                                "discordId": author_id,
                                "username": author.get("username") or None,
                                "globalName": author.get("global_name") or None,
                                "avatarUrl": self._user_avatar_url(author_id, author.get("avatar")),
                            }

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
                                    author_name=self._user_display_name(ref_author) or None,
                                    published_at=ref.get("timestamp"),
                                )
                            )

                        # creator_name = channel name (stable, identifies the channel)
                        # title = message author name (per-message, displayed in the UI)
                        channel_name = channel_names.get(cid, f"channel-{cid}")
                        post = ScrapedPost(
                            external_id=mid,
                            creator_external_id=cid,
                            service_type="discord",
                            title=author_name or None,
                            content=content or None,
                            published_at=ts,
                            attachments=attachments,
                            comments=comments,
                            creator_name=channel_name,
                            discord_author_id=author_id,
                            discord_guild_id=guild_id,
                            discord_author_info=discord_author_info,
                        )
                        all_posts.append(post)
                    except Exception as exc:
                        self.logger.warning(
                            "Failed to process Discord message — skipping",
                            extra={"job_id": self.job_id, "message_id": mid, "channel_id": cid, "error": str(exc)},
                        )
                        continue

                    overall_progress = int(
                        (c_idx / n_channels + (idx + 1) / (total * n_channels)) * 100
                    )
                    if self.flush_callback and (idx + 1) % 20 == 0:
                        # Always pass discord_server_info so the backend creates/updates
                        # the DiscordServer record before processing each batch of messages.
                        await self.flush_callback(
                            all_posts[flushed:], [], overall_progress,
                            f"Channel {c_idx + 1}/{len(channel_ids)}: "
                            f"processed {idx + 1}/{total} messages",
                            discord_server_info,
                        )
                        flushed = len(all_posts)

                    await asyncio.sleep(_POST_DELAY)

        return ScrapeResult(
            posts=all_posts[flushed:],
            items=[],
            progress_pct=100,
            discord_server_info=discord_server_info,
        )

    # ------------------------------------------------------------------
    # Server info builder
    # ------------------------------------------------------------------

    def _build_server_info(
        self,
        guild_id: str,
        guild_info: dict[str, Any],
        all_channels: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Build the discord_server_info payload from raw API responses."""
        icon_url = self._guild_icon_url(guild_id, guild_info.get("icon"))
        roles = [
            {
                "roleId": str(r["id"]),
                "name": r.get("name", ""),
                "color": int(r.get("color", 0)),
                "position": int(r.get("position", 0)),
            }
            for r in (guild_info.get("roles") or [])
            if r.get("id")
        ]
        channels = [
            {
                "channelId": str(c["id"]),
                "name": c.get("name") or f"channel-{c['id']}",
                "type": int(c.get("type", 0)),
                "parentId": str(c["parent_id"]) if c.get("parent_id") else None,
                "position": int(c.get("position", 0)),
            }
            for c in all_channels
            if c.get("id")
        ]
        return {
            "guildId": guild_id,
            "name": guild_info.get("name") or f"server-{guild_id}",
            "iconUrl": icon_url,
            "roles": roles,
            "channels": channels,
        }

