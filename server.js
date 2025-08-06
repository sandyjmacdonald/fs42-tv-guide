// server.js
import express      from 'express';
import fetch        from 'node-fetch';
import pMap         from 'p-map';
import dotenv       from 'dotenv';
import { LRUCache } from 'lru-cache';
import path         from 'path';
import fs           from 'fs';

dotenv.config();

const app      = express();
const TV_BASE  = process.env.FS42_API_URL;
const TMDB_KEY = process.env.TMDB_KEY;
if (!TV_BASE)  throw new Error('Set FS42_API_URL in .env');
if (!TMDB_KEY) throw new Error('Set TMDB_KEY in .env');

// In-memory cache: up to 1000 entries, 1-hour TTL
const tmdbCache = new LRUCache({ max: 1000, ttl: 1000 * 60 * 60 });
let lastCall = 0;

// 1) Proxy channel list
app.get('/api/stations', async (req, res) => {
  try {
    const j = await fetch(`${TV_BASE}/summary/stations`).then(r => r.json());
    res.json(j.network_names);
  } catch (e) {
    console.error('Stations fetch error', e);
    res.status(502).json([]);
  }
});

// 2) Proxy schedule blocks with TMDb ID enrichment
app.get('/api/schedules/:net', async (req, res) => {
  const net   = encodeURIComponent(req.params.net);
  const { start, end } = req.query;
  const url   = `${TV_BASE}/schedules/${net}?start=${start}&end=${end}`;
  try {
    const j = await fetch(url).then(r => r.json());
    const blocks = j.schedule_blocks || [];

    // Enrich each block with tmdb_id (movies) or series_id (TV)
    const enriched = await pMap(blocks, async blk => {
      let raw = blk.title.trim();
      const cutMatch = raw.match(/^(.*S\d{2}E\d{2})/i);
      if (cutMatch) raw = cutMatch[1];
      let tmdb_id = null, series_id = null;

      // TV episode?
      const epMatch = raw.match(/^(.*?)\s[-–]\s*S(\d+?)E(\d+?)(?:[-–]E\d+)?$/i);
      if (epMatch) {
        const seriesName = epMatch[1].trim();
        const searchUrl = new URL('https://api.themoviedb.org/3/search/tv');
        searchUrl.searchParams.set('api_key', TMDB_KEY);
        searchUrl.searchParams.set('query', seriesName);
        const searchJ = await (await fetch(searchUrl)).json();
        if (searchJ.results?.length) {
          series_id = searchJ.results[0].id;
        }
        return { ...blk, tmdb_id, series_id, starRating: null };
      } else {
        // Movie?
        const mvMatch = raw.match(/^(.*?)\s*\((\d{4})\)\s*$/);
        if (mvMatch) {
          const movieName = mvMatch[1].trim();
          const movieYear = mvMatch[2];
          const mUrl = new URL('https://api.themoviedb.org/3/search/movie');
          mUrl.searchParams.set('api_key', TMDB_KEY);
          mUrl.searchParams.set('query', movieName);
          mUrl.searchParams.set('year', movieYear);
          const mJ = await (await fetch(mUrl)).json();
          if (mJ.results?.length) {
            tmdb_id = mJ.results[0].id;
            if (tmdb_id) {
              const detailsUrl = new URL(`https://api.themoviedb.org/3/movie/${tmdb_id}`);
              detailsUrl.searchParams.set('api_key', TMDB_KEY);
              const detailsJ = await (await fetch(detailsUrl)).json();
              const starRating = detailsJ.vote_average || 0;
              // attach rating
              return { ...blk, tmdb_id, series_id, starRating };
            }
          }
        }
      }

      return { ...blk, tmdb_id, series_id, starRating: null };
    }, { concurrency: 4 });

    res.json(enriched);
  } catch (e) {
    console.error('Schedule fetch error for', net, e);
    res.status(502).json([]);
  }
});

// 3) Proxy summary of all stations
app.get('/api/summary', async (req, res) => {
  try {
    const j = await fetch(`${TV_BASE}/summary`).then(r => r.json());
    res.json(j);
  } catch (e) {
    console.error('Summary fetch error', e);
    res.status(502).json({ summary_data: [] });
  }
});

// 4) TMDb summary + certification lookup
app.get('/api/tmdb-summary', async (req, res) => {
  const title = (req.query.title || '').trim();
  if (!title) return res.json({ overview: '', certification: '', image: '' });
  if (tmdbCache.has(title)) {
    return res.json(tmdbCache.get(title));
  }

  // throttle to 4/sec
  const now = Date.now();
  const wait = Math.max(0, 250 - (now - lastCall));
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();

  let overview = '', certification = '', image = '';
  let series_id = null;
  try {
    const epMatch = title.match(/^(.*?)\s[-–]\s*S(\d+?)E(\d+?)(?:[-–]E\d+)?$/i);
    if (epMatch) {
      // TV episode
      const [, seriesName, seasonStr, episodeStr] = epMatch;
      const season = parseInt(seasonStr, 10), episode = parseInt(episodeStr, 10);
      const searchUrl = new URL('https://api.themoviedb.org/3/search/tv');
      searchUrl.searchParams.set('api_key', TMDB_KEY);
      searchUrl.searchParams.set('query', seriesName);
      const searchJ = await (await fetch(searchUrl)).json();
      if (searchJ.results?.length) {
        const seriesId = searchJ.results[0].id;
        series_id = seriesId;
        const epUrl = `https://api.themoviedb.org/3/tv/${seriesId}`
                    + `/season/${season}/episode/${episode}`
                    + `?api_key=${TMDB_KEY}`;
        const epJ = await (await fetch(epUrl)).json();
        overview = epJ.overview || '';
        image = epJ.still_path || '';
        const tmdb_id = seriesId;
        const out = { overview, certification, tmdb_id, image, image_path: image, series_id };
        tmdbCache.set(title, out);
        return res.json(out);
      }
    } else {
      // Movie
      const mvMatch   = title.match(/^(.*?)\s*\((\d{4})\)\s*$/);
      const movieName = mvMatch ? mvMatch[1].trim() : title;
      const movieYear = mvMatch ? mvMatch[2] : '';
      const mUrl = new URL('https://api.themoviedb.org/3/search/movie');
      mUrl.searchParams.set('api_key', TMDB_KEY);
      mUrl.searchParams.set('query', movieName);
      if (movieYear) mUrl.searchParams.set('year', movieYear);
      const mJ = await (await fetch(mUrl)).json();
      let director = '';
      if (mJ.results?.length) {
        const m = mJ.results[0];
        // Fetch full movie details to get runtime
        const detailsUrl = `https://api.themoviedb.org/3/movie/${m.id}?api_key=${TMDB_KEY}`;
        const detailsJ = await (await fetch(detailsUrl)).json();
        const runtime = detailsJ.runtime || 0;
        overview = m.overview || '';
        image = m.backdrop_path || m.poster_path || '';
        const tmdb_id = m.id;
        const rdUrl = `https://api.themoviedb.org/3/movie/${m.id}/release_dates?api_key=${TMDB_KEY}`;
        const rdJ = await (await fetch(rdUrl)).json();
        const usEntry = (rdJ.results || []).find(r => r.iso_3166_1 === 'US');
        if (usEntry && Array.isArray(usEntry.release_dates)) {
          const cd = usEntry.release_dates.find(d => d.certification);
          certification = cd?.certification || '';
        }
        // Director lookup
        const creditsUrl = `https://api.themoviedb.org/3/movie/${m.id}/credits?api_key=${TMDB_KEY}`;
        const creditsJ   = await (await fetch(creditsUrl)).json();
        const directorEntry = (creditsJ.crew || [])
          .find(c => c.job === 'Director');
        director = directorEntry ? directorEntry.name : '';
        const out = { overview, certification, director, tmdb_id, image, image_path: image, runtime, series_id: null };
        tmdbCache.set(title, out);
        return res.json(out);
      }
    }
  } catch (err) {
    console.error('TMDb lookup error for', title, err);
  }

  const out = { overview, certification, image: '', runtime: 0, series_id: null };
  tmdbCache.set(title, out);
  res.json(out);
});

// 5) Proxy “zap to channel” requests
app.get('/api/player/channels/:chanNum', async (req, res) => {
  const { chanNum } = req.params;
  try {
    const response = await fetch(`${TV_BASE}/player/channels/${chanNum}`);
    res.sendStatus(response.status);
  } catch (err) {
    console.error('Channel-zap proxy error for', chanNum, err);
    res.sendStatus(502);
  }
});

// Inject IGNORE_CHANS into window for client-side use
app.get('/', (req, res) => {
  const indexPath = path.join(process.cwd(), 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const script = `<script>window.IGNORE_CHANS = ${JSON.stringify(process.env.IGNORE_CHANS || '')};</script>`;
  html = html.replace('</head>', `${script}</head>`);
  res.send(html);
});

// 6) Serve static frontend
app.use(express.static(path.join(process.cwd(), 'public')));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📺 TV-guide proxy listening at http://localhost:${PORT}/`);
});