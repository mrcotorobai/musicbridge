require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ---------------------- constants ---------------------- */

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const ITUNES_LOOKUP = 'https://itunes.apple.com/lookup';

/* ---------------------- spotify auth ---------------------- */

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

/* ---------------------- url parsing ---------------------- */

function parseInputUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname;
    const parts = url.pathname.split('/').filter(Boolean);

    // Spotify
    if (host.includes('open.spotify.com')) {
      if (parts[0] === 'track') {
        return { platform: 'spotify', kind: 'song', id: parts[1] || null, raw: url };
      }
      if (parts[0] === 'album') {
        return { platform: 'spotify', kind: 'album', id: parts[1] || null, raw: url };
      }
      return { platform: 'spotify', kind: 'unknown', id: null, raw: url };
    }

    // Apple Music / iTunes
    if (host.includes('music.apple.com') || host.includes('itunes.apple.com')) {
      // Song links: often album path with ?i=<trackId>
      const aTrackId = url.searchParams.get('i');
      if (aTrackId) return { platform: 'apple', kind: 'song', id: aTrackId, raw: url };

      // Album links: /{country}/album/{slug}/{albumId}
      const albumIdx = parts.findIndex(p => p === 'album');
      if (albumIdx !== -1) {
        const maybeId = parts[albumIdx + 2]; // slug then id
        if (maybeId && /^\d+$/.test(maybeId)) {
          return { platform: 'apple', kind: 'album', id: maybeId, raw: url };
        }
        // Sometimes path ends right after slug; try last numeric segment
        const last = parts[parts.length - 1];
        if (last && /^\d+$/.test(last)) {
          return { platform: 'apple', kind: 'album', id: last, raw: url };
        }
      }
      return { platform: 'apple', kind: 'unknown', id: null, raw: url };
    }

    return { platform: 'unknown', kind: 'unknown', id: null, raw: u };
  } catch {
    return { platform: 'invalid', kind: 'invalid', id: null, raw: u };
  }
}

/* ---------------------- spotify: tracks & albums ---------------------- */

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

async function getSpotifyAlbum(albumId, token) {
  const resp = await fetch(`${SPOTIFY_API_BASE}/albums/${encodeURIComponent(albumId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Spotify album fetch failed: ${resp.status} ${t}`);
  }
  return resp.json();
}

async function searchSpotifyTrackByIsrc(isrc, token) {
  const q = `isrc:${isrc}`;
  const url = `${SPOTIFY_API_BASE}/search?q=${encodeURIComponent(q)}&type=track&limit=1`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const json = await resp.json();
  const item = json?.tracks?.items?.[0];
  if (!item) return null;
  return { url: item.external_urls?.spotify, id: item.id, name: item.name, artists: item.artists?.map(a => a.name) };
}

async function searchSpotifyTrackByText(name, artist, token) {
  const q = `track:${name} artist:${artist}`;
  const url = `${SPOTIFY_API_BASE}/search?q=${encodeURIComponent(q)}&type=track&limit=3`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const json = await resp.json();
  const item = json?.tracks?.items?.[0];
  if (!item) return null;
  return { url: item.external_urls?.spotify, id: item.id, name: item.name, artists: item.artists?.map(a => a.name) };
}

async function searchSpotifyAlbumByUpc(upc, token) {
  const q = `upc:${upc}`;
  const url = `${SPOTIFY_API_BASE}/search?q=${encodeURIComponent(q)}&type=album&limit=1`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const json = await resp.json();
  const item = json?.albums?.items?.[0];
  if (!item) return null;
  return { url: item.external_urls?.spotify, id: item.id, name: item.name, artists: item.artists?.map(a => a.name) };
}

async function searchSpotifyAlbumByText(name, artist, token) {
  const q = `album:${name} artist:${artist}`;
  const url = `${SPOTIFY_API_BASE}/search?q=${encodeURIComponent(q)}&type=album&limit=3`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const json = await resp.json();
  const item = json?.albums?.items?.[0];
  if (!item) return null;
  return { url: item.external_urls?.spotify, id: item.id, name: item.name, artists: item.artists?.map(a => a.name) };
}

/* ---------------------- apple: iTunes search/lookup ---------------------- */

async function itunesLookupById(id, country = 'us', entity = 'song') {
  if (!id) return null;
  const url = `${ITUNES_LOOKUP}?id=${encodeURIComponent(id)}&country=${encodeURIComponent(country)}&entity=${encodeURIComponent(entity)}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  return json.results?.[0] || null;
}

// songs
async function itunesSearchSongByIsrc(isrc, country = 'us') {
  const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(isrc)}&entity=song&attribute=isrcTerm&country=${encodeURIComponent(country)}&limit=5`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  const item = json.results?.find(r => r.kind === 'song');
  if (!item) return null;
  return normalizeItunesSong(item);
}
async function itunesSearchSongByText(name, artist, country = 'us') {
  const term = `${name} ${artist}`;
  const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(term)}&entity=song&country=${encodeURIComponent(country)}&limit=5`;
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

// albums
async function itunesSearchAlbumByUpc(upc, country = 'us') {
  // UPC search is an unofficial but commonly supported attribute (like isrcTerm)
  const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(upc)}&entity=album&attribute=upcTerm&country=${encodeURIComponent(country)}&limit=5`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  const item = json.results?.find(r => r.collectionType === 'Album' || r.collectionId);
  if (!item) return null;
  return normalizeItunesAlbum(item);
}
async function itunesSearchAlbumByText(name, artist, country = 'us') {
  const term = `${name} ${artist}`;
  const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(term)}&entity=album&country=${encodeURIComponent(country)}&limit=5`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  const item = json.results?.find(r => r.collectionType === 'Album' || r.collectionId);
  if (!item) return null;
  return normalizeItunesAlbum(item);
}
function normalizeItunesAlbum(item) {
  return {
    name: item.collectionName,
    artists: [item.artistName],
    upc: item.upc || null, // often not present in iTunes JSON
    appleUrl: item.collectionViewUrl || null,
    artwork: item.artworkUrl100 || null,
    collectionId: item.collectionId || null,
  };
}

/* ---------------------- routes ---------------------- */

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'musicbridge-mapper',
    routes: [
      '/health',
      '/map/song?url=<spotify_or_apple_song_link>&country=us',
      '/r/song?url=<spotify_or_apple_song_link>&country=us',
      '/map/album?url=<spotify_or_apple_album_link>&country=us',
      '/r/album?url=<spotify_or_apple_album_link>&country=us'
    ]
  });
});

app.get('/health', (_req, res) => res.send('ok'));

/* -------- songs: JSON mapper -------- */
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

      let apple = null;
      if (isrc) apple = await itunesSearchSongByIsrc(isrc, country);
      if (!apple) apple = await itunesSearchSongByText(name, artist, country);

      return res.json({
        ok: true,
        direction: 'spotify→apple',
        input: { url, trackId: parsed.id, name, artist, isrc },
        match: apple || null,
      });
    }

    if (parsed.platform === 'apple' && parsed.kind === 'song') {
      const lookup = await itunesLookupById(parsed.id, country, 'song');
      const name = lookup?.trackName || null;
      const artist = lookup?.artistName || null;
      const isrc = lookup?.isrc || null;

      const token = await getSpotifyToken();
      let sp = null;
      if (isrc) sp = await searchSpotifyTrackByIsrc(isrc, token);
      if (!sp && name && artist) sp = await searchSpotifyTrackByText(name, artist, token);

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

/* -------- songs: redirect -------- */
app.get('/r/song', async (req, res) => {
  try {
    const { url, country = 'us' } = req.query;
    if (!url) return res.status(400).send('Missing ?url=');

    const u = new URL(`http://127.0.0.1:${PORT}/map/song`);
    u.searchParams.set('url', url);
    u.searchParams.set('country', country);

    const r = await fetch(u.toString());
    if (!r.ok) return res.status(502).send(`Mapper failed: ${r.status}`);
    const data = await r.json();

    let target = null;
    if (data?.direction === 'spotify→apple') target = data?.match?.appleUrl || null;
    if (data?.direction === 'apple→spotify') target = data?.match?.url || null;

    if (!data?.ok || !target) return res.status(404).send('No match found');
    return res.redirect(302, target);
  } catch (e) {
    console.error(e);
    return res.status(500).send('Internal error');
  }
});

/* -------- albums: JSON mapper -------- */
app.get('/map/album', async (req, res) => {
  const { url, country = 'us' } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: 'Missing ?url=' });

  const parsed = parseInputUrl(url);
  try {
    if (parsed.platform === 'spotify' && parsed.kind === 'album' && parsed.id) {
      const token = await getSpotifyToken();
      const album = await getSpotifyAlbum(parsed.id, token);
      const name = album.name;
      const artist = album.artists?.[0]?.name || '';
      const upc = album.external_ids?.upc || null;

      let apple = null;
      if (upc) apple = await itunesSearchAlbumByUpc(upc, country);
      if (!apple) apple = await itunesSearchAlbumByText(name, artist, country);

      return res.json({
        ok: true,
        direction: 'spotify→apple',
        input: { url, albumId: parsed.id, name, artist, upc },
        match: apple || null,
      });
    }

    if (parsed.platform === 'apple' && parsed.kind === 'album' && parsed.id) {
      const lookup = await itunesLookupById(parsed.id, country, 'album');
      const name = lookup?.collectionName || null;
      const artist = lookup?.artistName || null;

      const token = await getSpotifyToken();
      // iTunes lookup usually doesn’t expose UPC; rely on text search.
      let sp = null;
      if (name && artist) sp = await searchSpotifyAlbumByText(name, artist, token);

      return res.json({
        ok: true,
        direction: 'apple→spotify',
        input: { url, appleAlbumId: parsed.id, name, artist },
        match: sp || null,
      });
    }

    return res.status(400).json({ ok: false, error: 'Unsupported or invalid URL; only albums supported on this endpoint.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* -------- albums: redirect -------- */
app.get('/r/album', async (req, res) => {
  try {
    const { url, country = 'us' } = req.query;
    if (!url) return res.status(400).send('Missing ?url=');

    const u = new URL(`http://127.0.0.1:${PORT}/map/album`);
    u.searchParams.set('url', url);
    u.searchParams.set('country', country);

    const r = await fetch(u.toString());
    if (!r.ok) return res.status(502).send(`Mapper failed: ${r.status}`);
    const data = await r.json();

    let target = null;
    if (data?.direction === 'spotify→apple') target = data?.match?.appleUrl || null;
    if (data?.direction === 'apple→spotify') target = data?.match?.url || null;

    if (!data?.ok || !target) return res.status(404).send('No match found');
    return res.redirect(302, target);
  } catch (e) {
    console.error(e);
    return res.status(500).send('Internal error');
  }
});

/* ---------------------- start server ---------------------- */

app.listen(PORT, () => {
  console.log(`Mapping service listening on port ${PORT}`);
});
