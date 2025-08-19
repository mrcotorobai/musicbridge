require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ---------------------- helpers ---------------------- */

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const ITUNES_LOOKUP = 'https://itunes.apple.com/lookup';

async function getSpotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env');
  }
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const resp = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Spotify token failed: ${resp.status} ${text}`);
  }
  const json = await resp.json();
  return json.access_token;
}

function parseInputUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname;
    if (host.includes('open.spotify.com')) {
      // Expect /track/:id
      const parts = url.pathname.split('/').filter(Boolean);
      return parts[0] === 'track'
        ? { platform: 'spotify', kind: 'song', id: parts[1], raw: url }
        : { platform: 'spotify', kind: 'unknown', id: null, raw: url };
    }
    if (host.includes('music.apple.com') || host.includes('itunes.apple.com')) {
      // Apple song links often have ?i=<trackId> on album path
      const aTrackId = url.searchParams.get('i');
      return { platform: 'apple', kind: 'song', id: aTrackId, raw: url };
    }
    return { platform: 'unknown', kind: 'unknown', id: null, raw: u };
  } catch (e) {
    return { platform: 'invalid', kind: 'invalid', id: null, raw: u };
  }
}

/* -------- Spotify side: get track + search by ISRC/text -------- */

async function getSpotifyTrack(trackId, token) {
  const resp = await fetch(`${SPOTIFY_API_BASE}/tracks/${encodeURIComponent(trackId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Spotify track fetch failed: ${resp.status} ${t}`);
  }
  return resp.json();
}

async function searchSpotifyByIsrc(isrc, token) {
  const q = `isrc:${isrc}`;
  const url = `${SPOTIFY_API_BASE}/search?q=${encodeURIComponent(q)}&type=track&limit=1`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const json = await resp.json();
  const item = json?.tracks?.items?.[0];
  if (!item) return null;
  return { url: item.external_urls?.spotify, id: item.id, name: item.name, artists: item.artists?.map(a => a.name) };
}

async function searchSpotifyByText(name, artist, token) {
  const q = `track:${name} artist:${artist}`;
  const url = `${SPOTIFY_API_BASE}/search?q=${encodeURIComponent(q)}&type=track&limit=3`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const json = await resp.json();
  const item = json?.tracks?.items?.[0];
  if (!item) return null;
  return { url: item.external_urls?.spotify, id: item.id, name: item.name, artists: item.artists?.map(a => a.name) };
}

/* -------- Apple side (via iTunes Search/Lookup for now) -------- */

async function itunesLookupById(id, country = 'us') {
  if (!id) return null;
  const url = `${ITUNES_LOOKUP}?id=${encodeURIComponent(id)}&country=${encodeURIComponent(country)}&entity=song`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  return json.results?.[0] || null;
}

// Try ISRC first (undocumented but widely used): attribute=isrcTerm
async function itunesSearchByIsrc(isrc, country = 'us') {
  const url =
    `${ITUNES_SEARCH}?term=${encodeURIComponent(isrc)}&entity=song&attribute=isrcTerm&country=${encodeURIComponent(country)}&limit=5`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  const item = json.results?.find(r => r.kind === 'song');
  if (!item) return null;
  return normalizeItunesSong(item);
}

async function itunesSearchByText(name, artist, country = 'us') {
  const term = `${name} ${artist}`;
  const url =
    `${ITUNES_SEARCH}?term=${encodeURIComponent(term)}&entity=song&country=${encodeURIComponent(country)}&limit=5`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  const item = json.results?.find(r => r.kind === 'song');
  if (!item) return null;
  return normalizeItunesSong(item);
}

function normalizeItunesSong(item) {
  return {
    name: item.trackName,
    artists: [item.artistName],
    album: item.collectionName,
    isrc: item.isrc || null,
    appleUrl: item.trackViewUrl || item.collectionViewUrl || null,
    previewUrl: item.previewUrl || null,
  };
}

/* ---------------------- routes ---------------------- */

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'musicbridge-mapper',
    routes: [
      '/health',
      '/map/song?url=<spotify_or_apple_song_link>&country=us'
    ]
  });
});

app.get('/health', (_req, res) => res.send('ok'));

/**
 * GET /map/song?url=<incomingLink>&country=us
 * - Detect link origin
 * - Pull metadata (try ISRC)
 * - Map to other platform using ISRC-first, text fallback
 */
app.get('/map/song', async (req, res) => {
  const { url, country = 'us' } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: 'Missing ?url=' });

  const parsed = parseInputUrl(url);
  try {
    if (parsed.platform === 'spotify' && parsed.kind === 'song' && parsed.id) {
      const token = await getSpotifyToken();
      const track = await getSpotifyTrack(parsed.id, token);
      const name = track.name;
      const artist = track.artists?.[0]?.name || '';
      const isrc = track.external_ids?.isrc || null;

      // Map to Apple
      let apple = null;
      if (isrc) apple = await itunesSearchByIsrc(isrc, country);
      if (!apple) apple = await itunesSearchByText(name, artist, country);

      return res.json({
        ok: true,
        direction: 'spotify→apple',
        input: { url, trackId: parsed.id, name, artist, isrc },
        match: apple || null,
      });
    }

    if (parsed.platform === 'apple' && parsed.kind === 'song') {
      // We may have the iTunes track id in ?i=
      const lookup = await itunesLookupById(parsed.id, country);
      const name = lookup?.trackName || null;
      const artist = lookup?.artistName || null;
      const isrc = lookup?.isrc || null;

      const token = await getSpotifyToken();
      // Try Spotify by ISRC, then by text
      let sp = null;
      if (isrc) sp = await searchSpotifyByIsrc(isrc, token);
      if (!sp && name && artist) sp = await searchSpotifyByText(name, artist, token);

      return res.json({
        ok: true,
        direction: 'apple→spotify',
        input: { url, appleTrackId: parsed.id, name, artist, isrc },
        match: sp || null,
      });
    }

    return res.status(400).json({ ok: false, error: 'Unsupported or invalid URL; only single tracks supported right now.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* ---------------------- start server ---------------------- */

app.listen(PORT, () => {
  console.log(`Mapping service listening on port ${PORT}`);
});
