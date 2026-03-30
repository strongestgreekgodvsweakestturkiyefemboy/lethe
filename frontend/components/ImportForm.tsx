'use client';

import { useState, useEffect } from 'react';
import JobProgressTracker from './JobProgressTracker';

interface SiteField {
  id: string;
  label: string;
  placeholder: string;
  hint: string;
  required: boolean;
}

interface SiteConfig {
  id: string;
  label: string;
  fields: SiteField[];
}

interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  position: number;
}

const inputClass =
  'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500';

const SUPPORTED_SITES: SiteConfig[] = [
  {
    id: 'kemono',
    label: 'Kemono',
    fields: [
      {
        id: 'token',
        label: 'Session Token / Creator ID',
        placeholder: 'Paste creator URL, service/creator_id, or Kemono session cookie',
        hint: 'Paste a creator URL (e.g. https://kemono.cr/patreon/user/12345), enter service/creator_id (e.g. patreon/12345), or paste your Kemono session cookie to import all your favourited artists.',
        required: true,
      },
    ],
  },
  {
    id: 'patreon',
    label: 'Patreon',
    fields: [
      {
        id: 'sessionId',
        label: 'Session ID',
        placeholder: 'Paste your Patreon session_id cookie value',
        hint: 'Found in browser DevTools → Application → Cookies → patreon.com → key: session_id.',
        required: true,
      },
      {
        id: 'creatorUrl',
        label: 'Creator URL or Vanity (optional)',
        placeholder: 'https://www.patreon.com/creator  or just  creator',
        hint: 'Leave blank to import all creators you are subscribed to. Enter a Patreon creator URL or vanity slug to import only that creator.',
        required: false,
      },
    ],
  },
  {
    id: 'fanbox',
    label: 'Pixiv Fanbox',
    fields: [
      {
        id: 'token',
        label: 'Session Cookie',
        placeholder: 'Paste your FANBOXSESSID cookie value',
        hint: 'Found in browser DevTools → Application → Cookies → fanbox.cc → key: FANBOXSESSID.',
        required: true,
      },
    ],
  },
  {
    id: 'gumroad',
    label: 'Gumroad',
    fields: [
      {
        id: 'token',
        label: 'Session Cookie',
        placeholder: 'Paste your _gumroad_app_session cookie value',
        hint: 'Found in browser DevTools → Application → Cookies → gumroad.com → key: _gumroad_app_session.',
        required: true,
      },
    ],
  },
  {
    id: 'subscribestar',
    label: 'SubscribeStar',
    fields: [
      {
        id: 'token',
        label: 'Session Cookie',
        placeholder: 'Paste your _session cookie value',
        hint: 'Found in browser DevTools → Application → Cookies → subscribestar.adult → key: _session.',
        required: true,
      },
    ],
  },
  {
    id: 'onlyfans',
    label: 'OnlyFans',
    fields: [
      {
        id: 'token',
        label: 'Auth Token',
        placeholder: 'Paste your OnlyFans sess cookie or API auth token',
        hint: 'Found in browser DevTools → Application → Cookies (sess cookie) or Network tab (authorization header).',
        required: true,
      },
    ],
  },
  {
    id: 'fansly',
    label: 'Fansly',
    fields: [
      {
        id: 'token',
        label: 'Auth Token',
        placeholder: 'Paste your Fansly authorization header value',
        hint: 'Found in browser DevTools → Network tab → any API request → Request Headers → authorization.',
        required: true,
      },
    ],
  },
  {
    id: 'boosty',
    label: 'Boosty',
    fields: [
      {
        id: 'token',
        label: 'Session Cookie',
        placeholder: 'Paste your auth-token cookie value',
        hint: 'Found in browser DevTools → Application → Cookies → boosty.to → key: auth-token.',
        required: true,
      },
    ],
  },
  {
    id: 'dlsite',
    label: 'DLsite',
    fields: [
      {
        id: 'token',
        label: 'Session Cookie',
        placeholder: 'Paste your glsc cookie value',
        hint: 'Found in browser DevTools → Application → Cookies → dlsite.com → key: glsc.',
        required: true,
      },
    ],
  },
  {
    id: 'discord',
    label: 'Discord',
    fields: [
      {
        id: 'token',
        label: 'Token',
        placeholder: 'Paste your Discord token  (or  Bot <token>  for a bot)',
        hint: '',
        required: true,
      },
      {
        id: 'channelId',
        label: 'Guild / Channel ID',
        placeholder: 'guild_id/channel_id  or  channel_id',
        hint: 'Enter a guild_id/channel_id (e.g. 123456789/987654321) to archive a specific server channel, or just a channel_id for a non-server channel.',
        required: true,
      },
    ],
  },
  {
    id: 'fantia',
    label: 'Fantia',
    fields: [
      {
        id: 'token',
        label: 'Session Cookie',
        placeholder: 'Paste your _session_id cookie value',
        hint: 'Found in browser DevTools → Application → Cookies → fantia.jp → key: _session_id.',
        required: true,
      },
    ],
  },
];

/** Build the sessionToken string sent to the backend from per-site field values. */
function buildSessionToken(siteId: string, values: Record<string, string>): string {
  if (siteId === 'patreon') {
    const sessionId = (values['sessionId'] ?? '').trim();
    const creatorUrl = (values['creatorUrl'] ?? '').trim();
    if (creatorUrl) {
      return `session:${sessionId}|creator:${creatorUrl}`;
    }
    return `session:${sessionId}`;
  }

  if (siteId === 'discord') {
    const token = (values['token'] ?? '').trim();
    const channelId = (values['channelId'] ?? '').trim();
    return `${token}:${channelId}`;
  }

  return (values['token'] ?? '').trim();
}

const CONSOLE_SNIPPET =
  `webpackChunkdiscord_app.push([[Math.random()],{},e=>{for(let t of Object.values(e.c))try{let o=t?.exports?.default?.getToken;if("function"==typeof o&&"getToken"===o.name){let f=o();console.log(f)}}catch{}}])`;

export default function ImportForm() {
  const [enabledSiteIds, setEnabledSiteIds] = useState<Set<string> | null>(null);
  const [targetSite, setTargetSite] = useState(SUPPORTED_SITES[0].id);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [jobId, setJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch which importers are enabled from the backend on mount.
  // If the request fails we fall back to showing all importers.
  useEffect(() => {
    fetch('/api/v1/importers')
      .then((r) => r.json() as Promise<{ importers: { id: string; enabled: boolean }[] }>)
      .then(({ importers }) => {
        const enabled = new Set(importers.filter((i) => i.enabled).map((i) => i.id));
        setEnabledSiteIds(enabled);
        // If the currently selected site becomes disabled, switch to the first enabled one.
        if (!enabled.has(targetSite)) {
          const first = SUPPORTED_SITES.find((s) => enabled.has(s.id));
          if (first) setTargetSite(first.id);
        }
      })
      .catch(() => {
        // On failure show everything
        setEnabledSiteIds(new Set(SUPPORTED_SITES.map((s) => s.id)));
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only display sites that are currently enabled.
  const visibleSites = enabledSiteIds === null
    ? SUPPORTED_SITES
    : SUPPORTED_SITES.filter((s) => enabledSiteIds.has(s.id));

  // Discord-specific state
  const [discordGuilds, setDiscordGuilds] = useState<DiscordGuild[]>([]);
  const [discordChannels, setDiscordChannels] = useState<DiscordChannel[]>([]);
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null);
  const [selectedGuildName, setSelectedGuildName] = useState<string>('');
  const [saveSession, setSaveSession] = useState(false);
  const [fetchingGuilds, setFetchingGuilds] = useState(false);
  const [fetchingChannels, setFetchingChannels] = useState(false);
  const [discordFetchError, setDiscordFetchError] = useState<string | null>(null);
  const [openMethod, setOpenMethod] = useState<number | null>(null);

  const selectedSite = SUPPORTED_SITES.find((s) => s.id === targetSite) ?? visibleSites[0] ?? SUPPORTED_SITES[0];

  const handleSiteChange = (newSite: string) => {
    setTargetSite(newSite);
    setFieldValues({});
    setError(null);
    // Reset Discord state
    setDiscordGuilds([]);
    setDiscordChannels([]);
    setSelectedGuildId(null);
    setSelectedGuildName('');
    setDiscordFetchError(null);
    setOpenMethod(null);
  };

  const handleFieldChange = (fieldId: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [fieldId]: value }));
    // When the Discord token changes, reset the picker
    if (targetSite === 'discord' && fieldId === 'token') {
      setDiscordGuilds([]);
      setDiscordChannels([]);
      setSelectedGuildId(null);
      setSelectedGuildName('');
      setDiscordFetchError(null);
    }
  };

  // ── Discord picker helpers ────────────────────────────────────────────────

  const handleGetGuilds = async () => {
    const token = (fieldValues['token'] ?? '').trim();
    if (!token) return;
    setFetchingGuilds(true);
    setDiscordFetchError(null);
    setDiscordGuilds([]);
    setDiscordChannels([]);
    setSelectedGuildId(null);
    setSelectedGuildName('');
    try {
      const res = await fetch('/api/v1/discord/guilds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json() as { guilds?: DiscordGuild[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setDiscordGuilds(data.guilds ?? []);
    } catch (err) {
      setDiscordFetchError(err instanceof Error ? err.message : 'Failed to fetch servers.');
    } finally {
      setFetchingGuilds(false);
    }
  };

  const handleGuildSelect = async (guild: DiscordGuild) => {
    const token = (fieldValues['token'] ?? '').trim();
    setSelectedGuildId(guild.id);
    setSelectedGuildName(guild.name);
    setDiscordChannels([]);
    setFetchingChannels(true);
    setDiscordFetchError(null);
    try {
      const res = await fetch(`/api/v1/discord/guilds/${guild.id}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json() as { channels?: DiscordChannel[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setDiscordChannels(data.channels ?? []);
    } catch (err) {
      setDiscordFetchError(err instanceof Error ? err.message : 'Failed to fetch channels.');
    } finally {
      setFetchingChannels(false);
    }
  };

  const handleChannelPick = (guildId: string, channelId: string) => {
    setFieldValues((prev) => ({ ...prev, channelId: `${guildId}/${channelId}` }));
  };

  const handleWholeGuildPick = (guildId: string) => {
    // Trailing slash = archive all text channels in guild
    setFieldValues((prev) => ({ ...prev, channelId: `${guildId}/` }));
  };

  const handleBackToGuildList = () => {
    setSelectedGuildId(null);
    setSelectedGuildName('');
    setDiscordChannels([]);
  };

  // ── Submit ────────────────────────────────────────────────────────────────

  const primaryField = selectedSite.fields[0];
  const primaryValue = (fieldValues[primaryField.id] ?? '').trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const sessionToken = buildSessionToken(targetSite, fieldValues);
      const res = await fetch(
        `/api/v1/imports/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetSite, sessionToken, saveSession }),
        }
      );
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json() as { jobId: string };
      setJobId(data.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  if (jobId) {
    return <JobProgressTracker jobId={jobId} onReset={() => setJobId(null)} />;
  }

  const discordToken = (fieldValues['token'] ?? '').trim();
  const discordChannelId = (fieldValues['channelId'] ?? '').trim();

  return (
    <form onSubmit={handleSubmit} className="bg-gray-900 rounded-2xl p-8 shadow-xl space-y-6">
      <div>
        <label className="block text-sm font-medium mb-1" htmlFor="site">
          Target Site
        </label>
        <select
          id="site"
          value={targetSite}
          onChange={(e) => handleSiteChange(e.target.value)}
          className={inputClass}
        >
          {visibleSites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {targetSite === 'discord' ? (
        <>
          {/* ── Token field ── */}
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="field-token">
              Token
            </label>
            <input
              id="field-token"
              type="text"
              value={fieldValues['token'] ?? ''}
              onChange={(e) => handleFieldChange('token', e.target.value)}
              placeholder="Paste your Discord token  (or  Bot <token>  for a bot)"
              required
              autoComplete="off"
              className={inputClass}
            />

            {/* Collapsible token instructions */}
            <div className="mt-2 space-y-1">
              <div className="rounded-lg border border-gray-700 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenMethod(openMethod === 1 ? null : 1)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-indigo-300 hover:bg-gray-800 transition-colors"
                >
                  <span>Method 1 — Browser DevTools</span>
                  <span className="text-gray-400">{openMethod === 1 ? '▲' : '▼'}</span>
                </button>
                {openMethod === 1 && (
                  <div className="px-3 pb-3 text-xs text-gray-300 bg-gray-800 space-y-1">
                    <p className="pt-2">
                      Open Discord in your browser → press <kbd className="bg-gray-700 px-1 rounded">F12</kbd> →{' '}
                      <strong>Network</strong> tab → click any request to <code>discord.com/api</code> →{' '}
                      <strong>Request Headers</strong> → copy the value next to <code>authorization</code>.
                    </p>
                    <p className="text-yellow-400">
                      Use a bot token (prefixed <code>Bot </code>) where possible — user (self-bot) tokens violate
                      Discord ToS.
                    </p>
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-gray-700 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenMethod(openMethod === 2 ? null : 2)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-indigo-300 hover:bg-gray-800 transition-colors"
                >
                  <span>Method 2 — Browser Console</span>
                  <span className="text-gray-400">{openMethod === 2 ? '▲' : '▼'}</span>
                </button>
                {openMethod === 2 && (
                  <div className="px-3 pb-3 text-xs text-gray-300 bg-gray-800 space-y-2">
                    <p className="pt-2">
                      Open Discord in your browser → press <kbd className="bg-gray-700 px-1 rounded">F12</kbd> →{' '}
                      <strong>Console</strong> tab → paste the snippet below and press{' '}
                      <kbd className="bg-gray-700 px-1 rounded">Enter</kbd>. Your token will appear in the console.
                    </p>
                    <pre className="bg-gray-900 rounded p-2 text-green-400 break-all whitespace-pre-wrap text-[10px] select-all">
                      {CONSOLE_SNIPPET}
                    </pre>
                    <p className="text-yellow-400">
                      User tokens violate Discord ToS. Use a bot token where possible.
                      This snippet relies on Discord&apos;s internal client structure and may stop working after Discord updates.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Server & Channel picker ── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleGetGuilds}
                disabled={!discordToken || fetchingGuilds}
                className="flex-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg py-2 text-sm font-medium transition-colors"
              >
                {fetchingGuilds ? 'Fetching servers…' : '🔍 Get Servers & Channels'}
              </button>
            </div>

            {discordFetchError && (
              <p className="text-red-400 text-xs">{discordFetchError}</p>
            )}

            {/* Guild list */}
            {discordGuilds.length > 0 && !selectedGuildId && (
              <div className="rounded-lg border border-gray-700 overflow-hidden">
                <p className="px-3 py-2 text-xs font-medium text-gray-400 bg-gray-800 border-b border-gray-700">
                  Select a server
                </p>
                <div className="max-h-48 overflow-y-auto divide-y divide-gray-700">
                  {discordGuilds.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => handleGuildSelect(g)}
                      className="w-full flex items-center gap-3 px-3 py-2 text-sm text-left hover:bg-gray-800 transition-colors"
                    >
                      {g.icon ? (
                        <img
                          src={`https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp?size=32`}
                          alt={g.name}
                          className="w-7 h-7 rounded-full flex-shrink-0"
                        />
                      ) : (
                        <span className="w-7 h-7 rounded-full bg-indigo-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                          {g.name.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className="truncate">{g.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Channel list */}
            {selectedGuildId && (
              <div className="rounded-lg border border-gray-700 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 bg-gray-800 border-b border-gray-700">
                  <button
                    type="button"
                    onClick={handleBackToGuildList}
                    className="text-xs text-indigo-300 hover:text-indigo-200"
                  >
                    ← Back
                  </button>
                  <span className="text-xs font-medium text-gray-300 truncate">{selectedGuildName}</span>
                </div>
                {fetchingChannels && (
                  <p className="px-3 py-2 text-xs text-gray-400">Loading channels…</p>
                )}
                {!fetchingChannels && (
                  <div className="max-h-48 overflow-y-auto divide-y divide-gray-700">
                    <button
                      type="button"
                      onClick={() => handleWholeGuildPick(selectedGuildId)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-800 transition-colors text-indigo-300"
                    >
                      <span>📁</span>
                      <span>Import entire server (all text channels)</span>
                    </button>
                    {discordChannels.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => handleChannelPick(selectedGuildId, c.id)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-800 transition-colors"
                      >
                        <span className="text-gray-400">#</span>
                        <span className="truncate">{c.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Channel ID field (shows selection or allows manual entry) ── */}
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="field-channelId">
              Guild / Channel ID
            </label>
            <input
              id="field-channelId"
              type="text"
              value={discordChannelId}
              onChange={(e) => handleFieldChange('channelId', e.target.value)}
              placeholder="guild_id/channel_id  or  channel_id"
              required
              autoComplete="off"
              className={inputClass}
            />
            <p className="text-xs text-indigo-300 mt-1">
              Use the picker above, or type manually: <code>guild_id/channel_id</code> for a server
              channel, <code>guild_id/</code> for all channels in a server, or just a{' '}
              <code>channel_id</code> for a non-server channel.
            </p>
          </div>
        </>
      ) : (
        selectedSite.fields.map((field) => (
          <div key={field.id}>
            <label className="block text-sm font-medium mb-1" htmlFor={`field-${field.id}`}>
              {field.label}
            </label>
            <input
              id={`field-${field.id}`}
              type="text"
              value={fieldValues[field.id] ?? ''}
              onChange={(e) => handleFieldChange(field.id, e.target.value)}
              placeholder={field.placeholder}
              required={field.required}
              autoComplete="off"
              className={inputClass}
            />
            {field.hint && (
              <p className="text-xs text-indigo-300 mt-1">{field.hint}</p>
            )}
          </div>
        ))
      )}

      <p className="text-xs text-gray-400 -mt-2">
        We never store your raw session token — it is encrypted before transmission.
      </p>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Save session checkbox */}
      <label className="flex items-center gap-3 cursor-pointer select-none group">
        <input
          type="checkbox"
          checked={saveSession}
          onChange={(e) => setSaveSession(e.target.checked)}
          className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500 cursor-pointer"
        />
        <span className="text-sm text-gray-300 group-hover:text-white transition-colors">
          Save session for auto-reimport
        </span>
      </label>

      <button
        type="submit"
        disabled={loading || !primaryValue}
        className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg py-2.5 font-semibold transition-colors"
      >
        {loading ? 'Starting import…' : 'Start Import'}
      </button>
    </form>
  );
}
