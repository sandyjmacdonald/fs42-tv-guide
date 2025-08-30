// public/main.js
import { h, render } from 'https://esm.sh/preact@10';
import { useState, useEffect } from 'https://esm.sh/preact@10/hooks';
import htm from 'https://esm.sh/htm@3';
const html = htm.bind(h);

// Enable compact mode via URL parameter
const params = new URLSearchParams(window.location.search);
if (params.get('mode') === 'compact') {
  document.body.classList.add('compact');
}

// Lightweight debug helper toggled via ?debug
const DEBUG = params.has('debug') || Boolean(window.DEBUG);
const dlog = (...args) => { if (DEBUG) console.debug('[TVG]', ...args); };

// Toggle fixed column widths when viewport is narrower than content
function updateFixedColumns() {
  const styles = getComputedStyle(document.documentElement);
  const chanCount = parseInt(styles.getPropertyValue('--chan-count'), 10);
  const rootFontSize = parseFloat(styles.fontSize);
  const chanWidthRem = parseFloat(styles.getPropertyValue('--chan-width'));
  const compactScale = parseFloat(styles.getPropertyValue('--compact-col-scale')) || 1;
  const isCompactMode = document.body.classList.contains('compact');

  const effectiveChanWidthRem = isCompactMode ? (chanWidthRem * compactScale) : chanWidthRem;
  const minTotalPx = (4 + chanCount * effectiveChanWidthRem) * rootFontSize;

  if (window.innerWidth < minTotalPx) {
    document.body.classList.add('fixed-cols');
  } else {
    document.body.classList.remove('fixed-cols');
  }
}
window.addEventListener('load', updateFixedColumns);
window.addEventListener('resize', updateFixedColumns);
// Run once on script load to set initial fixed-cols state
updateFixedColumns();

// Constants
const MS_PER_MINUTE = 60 * 1000;

const TV_SLUGIFY = name =>
  name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');

// Load ignored channel names injected by server
const rawIgnore = window.IGNORE_CHANS || '';
const IGNORE = new Set(rawIgnore.split(',').map(name => name.trim()).filter(Boolean));
const TV_EP_RX = /\s[-–]\s*S(\d+)E(\d+)(?:[-–]E\d+)?$/i;
const MOVIE_YR_RX = /\(\d{4}\)$/;
const OFFAIR_RX = /^offair$/i;

const imageEligibleMovies = new Set();
const shownImages = new Set();

function App() {
  // displayDate rolls back to yesterday if before 6 AM
  const currentDate = new Date();
  const displayDate = new Date(currentDate);
  if (currentDate.getHours() < 6) displayDate.setDate(displayDate.getDate() - 1);

  // State
  const [chanNumbers, setChanNumbers] = useState(null);
  const [channels, setChannels] = useState([]);
  const [labels, setLabels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentLabelIdx, setCurrentLabelIdx] = useState(null);

  // Real-time clock for current program highlighting
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNowMs(Date.now()), MS_PER_MINUTE);
    return () => clearInterval(iv);
  }, []);

  // Compute timeline bounds
  const startDt = new Date(displayDate);
  startDt.setHours(6,0,0,0);
  const endDt = new Date(displayDate);
  endDt.setDate(endDt.getDate() + 1);
  endDt.setHours(7,0,0,0);

  const start = startDt.getTime();
  const end = endDt.getTime();
  const slotMin = 5;
  const totalMin = (end - start) / MS_PER_MINUTE;
  const totalRows = (totalMin - 60) / slotMin;

  // Morning window for targeted debug (06:00–12:00 of displayDate)
  const morningStartMs = start;
  const morningEndMs = new Date(new Date(displayDate).setHours(12,0,0,0)).getTime();

  // Fetch channel-number map
  useEffect(() => {
    fetch('/api/summary')
      .then(r => r.json())
      .then(json => {
        const map = {};
        (json.summary_data || []).forEach(x => {
          map[x.network_name] = x.channel_number;
        });
        setChanNumbers(map);
      })
      .catch(() => setChanNumbers({}));
  }, []);

  // Helper: merge back-to-back OFF-AIR blocks
  function mergeOffair(blocks) {
    if (!blocks) return [];
    const sorted = blocks.slice().sort((a,b)=>new Date(a.start_time) - new Date(b.start_time));
    const merged = [];
    for (const blk of sorted) {
      const isOff = OFFAIR_RX.test(blk.title.trim());
      if (isOff && merged.length) {
        const last = merged[merged.length-1];
        if (
          OFFAIR_RX.test(last.title.trim()) &&
          new Date(blk.start_time).getTime() === new Date(last.end_time).getTime()
        ) {
          last.end_time = blk.end_time;
          continue;
        }
      }
      merged.push({ ...blk });
    }
    return merged;
  }

  // Helper: format a Date in local time as YYYY-MM-DDTHH:mm:ss (no timezone)
  const fmtLocal = (dt) => {
    const pad = (n) => String(n).padStart(2, '0');
    const y = dt.getFullYear();
    const m = pad(dt.getMonth()+1);
    const d = pad(dt.getDate());
    const H = pad(dt.getHours());
    const M = pad(dt.getMinutes());
    const S = pad(dt.getSeconds());
    return `${y}-${m}-${d}T${H}:${M}:${S}`;
  };

  // Fetch schedules once channel numbers are known
  useEffect(() => {
    if (chanNumbers === null) return;
    const startLocal = fmtLocal(new Date(start));
    const endLocal   = fmtLocal(new Date(end));
    fetch('/api/stations')
      .then(r => r.json())
      .then(list => {
        const nets = list.filter(n => !IGNORE.has(n));
        return Promise.all(
          nets.map(net =>
            fetch(
              `/api/schedules/${encodeURIComponent(net)}` +
              `?start=${encodeURIComponent(startLocal)}` +
              `&end=${encodeURIComponent(endLocal)}`
            )
            .then(r => r.json())
            .then(blocks => ({ net, blocks: mergeOffair(blocks) }))
          )
        );
      })
      .then(data => {
        // Single consolidated debug: log program block data used for rendering
        if (DEBUG) {
          try {
            console.groupCollapsed('[TVG] Program blocks');
            data.forEach(({ net, blocks }) => {
              const simplified = blocks.map(b => ({
                title: b.title,
                contentTitle: b.content?.title || null,
                start: b.start_time,
                end: b.end_time,
                tmdb_id: b.tmdb_id ?? null,
                series_id: b.series_id ?? null,
                starRating: b.starRating ?? null,
              }));
              console.debug(`[TVG] ${net}`, simplified);
            });
          } finally {
            console.groupEnd();
          }
        }
        setChannels(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [chanNumbers]);

  useEffect(() => {
    const movieTitles = channels.flatMap(c => c.blocks)
      .filter(b => MOVIE_YR_RX.test(b.title))
      .map(b => b.title);
    const shuffled = movieTitles.sort(() => 0.5 - Math.random());
    imageEligibleMovies.clear();
    shuffled.slice(0, 2).forEach(t => imageEligibleMovies.add(t));
  }, [channels]);

  // Build time labels and date header
  useEffect(() => {
    const L = [];
    for (let i = 0; i < totalRows; i++) {
      const dt = new Date(start + i * slotMin * MS_PER_MINUTE);
      const txt = dt.toTimeString().slice(0,5);
      if (dt.getMinutes() % 30 === 0) L.push({ idx:i, txt });
    }
    setLabels(L);

    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    document.querySelector('.hdr-day').textContent  = days[displayDate.getDay()];
    document.querySelector('.hdr-date').textContent =
      displayDate.toLocaleString('default',{ month:'long', day:'numeric' }).toUpperCase();
  }, []);

  useEffect(() => {
    if (labels.length === 0) return;
    const updateCurrent = () => {
      const now = Date.now();
      const isCompactMode = document.body.classList.contains('compact');
      if (isCompactMode) {
        // Highlight the current hour label
        const nowDt = new Date(now);
        const hourTxt = nowDt.toTimeString().slice(0,5).replace(/:\d{2}$/, ':00');
        const match = labels.find(l => l.txt === hourTxt);
        setCurrentLabelIdx(match ? match.idx : null);
      } else {
        const minutesSinceStart = (now - start) / MS_PER_MINUTE;
        const blockNumber = Math.floor(minutesSinceStart / 30);
        const labelIdx = blockNumber * (30 / slotMin);
        setCurrentLabelIdx(labelIdx);
      }
    };
    updateCurrent(); // Initial highlight
    const iv = setInterval(updateCurrent, MS_PER_MINUTE);
    return () => clearInterval(iv);
  }, [start, labels]);

  if (loading) {
    return html`<div style="padding:1rem;font-style:italic;">Loading…</div>`;
  }

  // Set channel count variable and compute CSS grid columns
  document.documentElement.style.setProperty('--chan-count', channels.length);
  updateFixedColumns();
  const cols = ['4em', ...channels.map(()=> '1fr')].join(' ');

  return html`
    <div id="grid-wrap">
      <div class="guide-container" style="grid-template-columns:${cols};">

        <!-- Corner -->
        <div class="corner"></div>

        <!-- Clickable channel headers -->
        ${channels.map((c,i) => {
          const num = chanNumbers[c.net];
          const zap = () => {
            if (!num) return;
            fetch(`/api/player/channels/${num}`)
              .catch(console.error);
          };
          return html`
            <div
              class="channel-header"
              style="grid-column:${i+2};"
              onClick=${zap}
            >
              ${c.net.toUpperCase()}
              ${num != null
                ? html`<span class="channel-num">${num}</span>`
                : null}
            </div>
          `;
        })}

        <!-- Time labels -->
        ${labels.map(({idx, txt}) => {
          const minutes = parseInt(txt.split(':')[1], 10);
          const isCompactMode = document.body.classList.contains('compact');
          const isVisibleSlot = !isCompactMode || minutes === 0;
          const isCurrentVisible = currentLabelIdx === idx && isVisibleSlot;
          return html`
            <div class="time-label${isCurrentVisible ? ' current' : ''}" style="grid-row:${idx+2};">
              ${txt}
            </div>
          `;
        })}

        <!-- Program blocks -->
        ${channels.flatMap((c,ci) =>
          c.blocks.filter(b=>new Date(b.start_time).getTime()<end)
                   .map(b=>{
            const sOff = (new Date(b.start_time)-start)/60000;
            const dOff = (Math.min(new Date(b.end_time), endDt)-new Date(b.start_time))/60000;
            const row  = Math.round(sOff/slotMin)+2;
            const span = Math.max(1, Math.round(dOff/slotMin));
            const raw  = ((b.content && b.content.title) ? b.content.title : b.title || '').trim();
            const isMovie = MOVIE_YR_RX.test(raw);
            const isOff   = OFFAIR_RX.test((b.title||'').trim()) || OFFAIR_RX.test(raw);
            const charLimit = Math.floor(span*totalMin/70);
            const disp = raw.replace(TV_EP_RX,'').trim();

            // Extract episode and series info for link
            const epMatch = raw.match(/[-–]\s*S(\d+)E(\d+)/i);
            const season  = epMatch ? parseInt(epMatch[1], 10) : null;
            const episode = epMatch ? parseInt(epMatch[2], 10) : null;

            // Extract IDs directly from block
            const { tmdb_id: tmdbId, series_id: seriesId } = b;

            // Compute display title and year span
            const baseTitle = disp.replace(/\s*\((\d{4})\)$/, '').trim();
            const yearMatch = raw.match(/\((\d{4})\)$/);
            const titleNode = html`
              ${baseTitle}
              <${Rating} title=${raw}/>
            `;

            // Determine if this block is currently airing
            const startMs = new Date(b.start_time).getTime();
            const endMsBlock = Math.min(new Date(b.end_time).getTime(), end);
            const isCurrentProgram = nowMs >= startMs && nowMs < endMsBlock;
            // Pick a random highlighter and random transform
            const highlighterUrl = `/textures/highlighter-${Math.floor(Math.random()*4)+1}.png`;
            const rotateDeg = Math.random() * 4 - 2;  // Random rotation between -2° and +2°
            const flipType = Math.random() < 0.5 ? 'X' : 'Y';  // Randomly choose horizontal or vertical flip
            const highlighterTransform = `rotate(${rotateDeg}deg) scale${flipType}(-1)`;

            // Build href
            let href = null;
            if (!isOff) {
              if (epMatch && seriesId) {
                href = `https://www.themoviedb.org/tv/${seriesId}-${TV_SLUGIFY(baseTitle)}/season/${season}/episode/${episode}`;
              } else if (isMovie && tmdbId) {
                href = `https://www.themoviedb.org/movie/${tmdbId}`;
              }
            }

            // Render title wrapper (always plain, never link)
            return html`
              <div class="program${isMovie?' movie':''}${isOff?' offair':''}"
                   style="grid-column:${ci+2}; grid-row:${row}/span ${span};">
                ${!isOff ? null : html`<div><span class="offair-label">OFF-AIR</span></div>`}

                ${!isOff
                  ? html`<${Summary}
                      title=${raw}
                      limit=${charLimit}
                      href=${href}
                      starRating=${b.starRating}
                      currentProg=${isCurrentProgram}
                      highlighterUrl=${highlighterUrl}
                      highlighterTransform=${highlighterTransform}
                    />`
                  : null}
              </div>
            `;
          })
        )}
        <div class="registration-marks"></div>
      </div>
    </div>
  `;
}

// Rating component
function Rating({ title }) {
  const [cert, setCert] = useState('');
  useEffect(() => {
    if (!TV_EP_RX.test(title) && !MOVIE_YR_RX.test(title)) return;
    fetch(`/api/tmdb-summary?title=${encodeURIComponent(title)}`)
      .then(r => r.json())
      .then(m => m.certification && setCert(m.certification.trim()))
      .catch(()=>{});
  }, [title]);
  return cert ? html`<span class="rating">(${cert})</span>` : null;
}

// Summary component with hover tooltip and images
function Summary({ title, limit, href, starRating, currentProg, highlighterUrl, highlighterTransform }) {
  const isValid = TV_EP_RX.test(title) || MOVIE_YR_RX.test(title);

  const epMatch = title.match(/[-–]\s*S(\d+)E(\d+)/i);
  const season  = epMatch ? parseInt(epMatch[1], 10) : null;
  const episode = epMatch ? parseInt(epMatch[2], 10) : null;

  const [full, setFull] = useState('');
  const [director, setDirector] = useState('');
  const [cert, setCert] = useState('');
  const [images, setImages] = useState([]);

  const shouldShowImage = MOVIE_YR_RX.test(title);

  useEffect(() => {
    if (!isValid) return;
    fetch(`/api/tmdb-summary?title=${encodeURIComponent(title)}`)
      .then(r => r.json())
      .then(m => {
        // validate expected keys
        if (!m || typeof m !== 'object') {
          console.error("TMDB summary fetch: No valid data received for title:", title, m);
          return;
        }
        setFull((m.overview || '').replace(/\s+/g, ' ').trim());
        setDirector(m.director || '');
        setCert(m.certification?.trim() || '');
        if (shouldShowImage && m.runtime >= 100 && !shownImages.has(title)) {
          if (Array.isArray(m.images) && m.images.length > 0) {
            const validImages = m.images
              .filter(img => typeof img === 'string' && img.trim().length > 0)
              .map(path => `https://image.tmdb.org/t/p/w185${path}`);
            setImages(validImages.slice(0, 1));
            shownImages.add(title);
          } else if (typeof m.image === 'string' && m.image.trim().length > 0) {
            const fullUrl = `https://image.tmdb.org/t/p/w185${m.image}`;
            setImages([fullUrl]);
            shownImages.add(title);
          }
        }
      })
      .catch((err) => {
        console.error("TMDB summary fetch error for title:", title, err);
      });
  }, [title, shouldShowImage, limit, isValid]);

  const showDescription = full && full.length > 0;
  const disp = showDescription ? (full.length > limit ? full.slice(0,limit)+'…' : full) : null;

  // Build display title and year match for title node
  const isMovie = MOVIE_YR_RX.test(title);
  const dispTitle = (isMovie ? 'MOVIE: ' : '') + title
    .replace(TV_EP_RX, '')
    .trim()
    .replace(/\s*\(\d{4}\)$/, '')
    .trim();
  const yearMatch = title.match(/\((\d{4})\)$/);

  let stars = null;
  if (isMovie && starRating != null) {
    const filled = Math.round(starRating / 2);
    const empty  = 5 - filled;
    stars = html`
      ${Array.from({ length: filled }).map(() =>
        html`<i class="fa-solid fa-star star filled" aria-hidden="true"></i>`
      )}
      ${Array.from({ length: empty }).map(() =>
        html`<i class="fa-regular fa-star star empty" aria-hidden="true"></i>`
      )}
    `;
  }

  // Build title node
  const titleNode = html`<span class="program-title">${dispTitle}</span>`;

  if (!showDescription) {
    // Corrected HTM template syntax for program-title-wrapper
    return html`
      <div
        class=${`program-title-wrapper${currentProg ? ' current-prog' : ''}`}
        style=${currentProg ? `--highlighter-url: url('${highlighterUrl}'); --highlighter-transform: ${highlighterTransform};` : ''}
      >
        ${titleNode}
      </div>
      <div class="summary"><i>No description available…</i></div>
    `;
  }

  const summaryContent = html`
    <div class="summary" title=${full}>
      ${disp}
      ${season!=null && episode!=null ? html` <i>(Sn. ${season} Ep. ${episode})</i>` : null}
      ${director ? html` <i>(Dir. ${director})</i>` : null}
    </div>
  `;

  // Insert the extras line after summaryContent with updated format
  const extrasLine = isMovie && cert
    ? html`
        <div class="movie-extras">
          ${yearMatch ? yearMatch[1] + '. ' : ''}
          Rated: ${cert}.
          ${stars ? html` <span class="star-wrapper">${stars}</span>` : null}
        </div>
      `
    : null;

  return href
    ? html`
      <a href=${href} target="_blank" rel="noopener noreferrer" class="program-link">
        <div
          class=${`program-title-wrapper${currentProg ? ' current-prog' : ''}`}
          style=${currentProg ? `--highlighter-url: url('${highlighterUrl}'); --highlighter-transform: ${highlighterTransform};` : ''}
        >
          ${titleNode}
        </div>
        ${summaryContent}
        ${extrasLine}
        ${images.map(u => html`<img src=${u} class="summary-image" />`)}
      </a>`
    : html`
      <div
        class=${`program-title-wrapper${currentProg ? ' current-prog' : ''}`}
        style=${currentProg ? `--highlighter-url: url('${highlighterUrl}'); --highlighter-transform: ${highlighterTransform};` : ''}
      >
        ${titleNode}
      </div>
      ${summaryContent}
      ${extrasLine}
      ${images.map(u => html`<img src=${u} class="summary-image" />`)}
    `;
}

render(html`<${App}/>`, document.getElementById('app'));
