'use client';

import { useState } from 'react';
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
        hint: 'User token from browser DevTools → Network tab → any API request → Request Headers → authorization. Use a bot token (prefixed "Bot ") where possible — user (self-bot) tokens violate Discord ToS.',
        required: true,
      },
      {
        id: 'channelId',
        label: 'Guild / Channel ID',
        placeholder: 'guild_id/channel_id  or  channel_id',
        hint: 'Enter a guild_id/channel_id (e.g. 123456/789012) to archive a specific server channel, or just a channel_id for a non-server channel. DM archiving is not supported.',
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

export default function ImportForm() {
  const [targetSite, setTargetSite] = useState(SUPPORTED_SITES[0].id);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [jobId, setJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSite = SUPPORTED_SITES.find((s) => s.id === targetSite) ?? SUPPORTED_SITES[0];

  const handleSiteChange = (newSite: string) => {
    setTargetSite(newSite);
    setFieldValues({});
    setError(null);
  };

  const handleFieldChange = (fieldId: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [fieldId]: value }));
  };

  const primaryField = selectedSite.fields[0];
  const primaryValue = (fieldValues[primaryField.id] ?? '').trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const sessionToken = buildSessionToken(targetSite, fieldValues);
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001'}/api/v1/imports/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetSite, sessionToken }),
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
          {SUPPORTED_SITES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {selectedSite.fields.map((field) => (
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
      ))}

      <p className="text-xs text-gray-400 -mt-2">
        We never store your raw session token — it is encrypted before transmission.
      </p>

      {error && <p className="text-red-400 text-sm">{error}</p>}

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
