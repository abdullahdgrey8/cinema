import {createHash} from 'node:crypto';

const ORIGIN = 'https://www.justwatch.com';
const ART_ORIGIN = 'https://images.justwatch.com';
const DAY_MS = 86_400_000;
const TITLE_PATH = /^\/us\/(?:movie|tv-show)\/[a-z0-9%-]{1,150}\/?$/i;
const GENRES = new Map(Object.entries({
  act:'Action', ani:'Animation', cmy:'Comedy', crm:'Crime', doc:'Documentary',
  drm:'Drama', fml:'Family', fnt:'Fantasy', hrr:'Horror', hst:'History',
  msc:'Music', rly:'Reality', rma:'Romance', scf:'Science fiction',
  spt:'Sports', trl:'Thriller', war:'War', wst:'Western',
}));
export const JUSTWATCH_SOURCE = 'JustWatch Global Streaming Charts';
const titleId = path => 'justwatch-' + createHash('sha256').update(path).digest('hex').slice(0, 20);

export function justWatchChartUrl(kind, period) {
  const url = new URL('/us/streaming-charts', ORIGIN);
  url.searchParams.set('c', 'global');
  url.searchParams.set('ct', period === 'month' ? 'monthly' : 'weekly');
  if (kind === 'tv') url.searchParams.set('t', 'shows');
  return url.href;
}

export function isJustWatchChartUrl(url) {
  return url.origin === ORIGIN && url.pathname === '/us/streaming-charts' &&
    ['movies', 'tv'].some(kind => ['week', 'month'].some(period => justWatchChartUrl(kind, period) === url.href));
}

export function justWatchReleaseUrl(year) {
  return ORIGIN + '/us/movies?release_year_from=' + year;
}

export function isJustWatchReleaseUrl(url) {
  const year = url.searchParams.get('release_year_from');
  return url.origin === ORIGIN && /^\d{4}$/.test(year||'') && url.href === justWatchReleaseUrl(year);
}

export function isJustWatchPosterUrl(url) {
  return url.origin === ART_ORIGIN && !url.username && !url.password && !url.search && !url.hash &&
    /^\/poster\/\d+\/s(?:166|332)\/[\w%-]+\.jpe?g$/i.test(url.pathname);
}

export function isJustWatchTitleUrl(url) {
  return url.origin === ORIGIN && !url.username && !url.password && !url.search && !url.hash &&
    TITLE_PATH.test(url.pathname);
}

export function isJustWatchBackdropUrl(url) {
  return url.origin === ART_ORIGIN && !url.username && !url.password && !url.search && !url.hash &&
    /^\/backdrop\/\d{1,15}\/s1440\/[\w%-]{1,150}\.(?:webp|jpg)$/i.test(url.pathname);
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
}

function posterFromRow(row) {
  for (const [tag] of row.matchAll(/<img\b[^>]*>/gi)) {
    try {
      const url = new URL(attributes(tag).src);
      if (isJustWatchPosterUrl(url)) return url.href;
    } catch {}
  }
  return null;
}

function hydrationEntries(html) {
  const script = /<script\b[^>]*\bid="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  try {
    const entries = JSON.parse(script?.[1]);
    return Array.isArray(entries) && entries.length <= 60_000 ? entries : [];
  } catch {
    return [];
  }
}

export function parseJustWatchBackdrop(html, titleUrl) {
  let url;
  try { url = new URL(titleUrl); } catch { return null; }
  if (!isJustWatchTitleUrl(url)) return null;
  const entries = hydrationEntries(html);
  const expected = url.pathname.toLowerCase().startsWith('/us/movie/') ? 'MovieContent' : 'ShowContent';
  const path = url.pathname.replace(/\/$/, '');
  const match = entries.find(entry => {
    const fullPath = entries[entry?.fullPath];
    return entries[entry?.__typename] === expected &&
      typeof fullPath === 'string' && fullPath.replace(/\/$/, '') === path;
  });
  const backdrops = entries[match?.backdrops];
  if (!Array.isArray(backdrops)) return null;
  for (const index of backdrops.slice(0, 8)) {
    const record = entries[index];
    if (entries[record?.__typename] !== 'Backdrop') continue;
    const template = entries[record.backdropUrl];
    if (typeof template !== 'string' ||
      !/^\/backdrop\/\d{1,15}\/\{profile\}\/[\w%-]{1,150}\.\{format\}$/i.test(template)) continue;
    const image = new URL(template.replace('{profile}', 's1440').replace('{format}', 'webp'), ART_ORIGIN);
    if (isJustWatchBackdropUrl(image)) return image.href;
  }
  return null;
}

// The SSR table is the chart authority. Optional hydration data adds facts
// only to title paths present in that table.
function titleDetails(html, kind) {
  const entries = hydrationEntries(html);
  const details = new Map();
  const genreNames = new Map();
  for (const entry of entries) {
    if (entries[entry?.__typename] !== 'Genre') continue;
    const name = GENRES.get(entries[entry.shortName]), id = entries[entry.id];
    if (name && typeof id === 'string') genreNames.set('Genre:' + id, name);
  }
  const knownType = kind === 'movies' ? 'MovieContent' : 'ShowContent';
  for (const entry of entries) {
    if (!entry || entries[entry.__typename] !== knownType) continue;
    const titlePath = entries[entry.fullPath], year = entries[entry.originalReleaseYear];
    if (typeof titlePath !== 'string' || !Number.isInteger(year) || year < 1880 || year > 2100) continue;
    const runtime = entries[entry.runtime], overview = entries[entry.shortDescription], rawGenres = entries[entry.genres];
    if (details.has(titlePath) && details.get(titlePath)?.year !== year) {
      details.set(titlePath, null);
      continue;
    }
    const genres = Array.isArray(rawGenres) ? [...new Set(rawGenres.slice(0, 12)
      .map(index => genreNames.get(entries[entries[index]?.__ref]))
      .filter(Boolean))] : [];
    details.set(titlePath, {year, title:entries[entry.title],
      overview:typeof overview === 'string' ? overview : '',
      runtime:Number.isInteger(runtime) && runtime > 0 && runtime <= 1200 ? runtime : null,
      genres,
    });
  }
  return details;
}

export function parseJustWatchChart(html, {kind, period, now = Date.now(), plainText}) {
  const chartTime = /Streaming charts last updated:[\s\S]{0,400}?datetime="([^"]+)"/i.exec(html)?.[1];
  const published = Date.parse(chartTime);
  if (!Number.isFinite(published) || published > now + 12 * 60 * 60 * 1000 || now - published > 7 * DAY_MS) {
    throw Error('JustWatch did not publish a current chart timestamp.');
  }
  const type = kind === 'movies' ? 'movie' : 'tv-show';
  const expectedPath = new RegExp('^/us/' + type + '/[a-z0-9%-]+/?$', 'i');
  const details = titleDetails(html, kind);
  const seenPaths = new Set(), seenRanks = new Set(), items = [];
  for (const [, row] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rank = Number(/<p\b[^>]*class="[^"]*\btitle-ranking-list__rank\b[^"]*"[^>]*>\s*(\d+)\s*\./i.exec(row)?.[1]);
    const title = plainText(/<div\b[^>]*class="[^"]*\blist__row__item__content__title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(row)?.[1]).slice(0, 180);
    const titlePath = [...row.matchAll(/<a\b[^>]*href="([^"]+)"/gi)].map(match => match[1])
      .find(value => expectedPath.test(value));
    if (!title || !titlePath || new URL(titlePath, ORIGIN).pathname !== titlePath ||
      !Number.isInteger(rank) || rank < 1 || rank > 100 || seenRanks.has(rank) || seenPaths.has(titlePath)) continue;
    seenPaths.add(titlePath);
    seenRanks.add(rank);
    const info=details.get(titlePath);
    items.push({
      id: titleId(titlePath), title, kind, year: info?.year || null, chartRank: rank, isSeries: kind === 'tv',
      posterRemote: posterFromRow(row), overview: plainText(info?.overview || '').slice(0, 900), runtime: info?.runtime || null, genres: info?.genres || [], confidence: 1,
      source: JUSTWATCH_SOURCE, sourceUrl: new URL(titlePath, ORIGIN).href,
      attribution: 'JustWatch activity ranking. Artwork rights belong to their owners.',
    });
  }
  if (items.length < 5 || !seenRanks.has(1)) throw Error('JustWatch did not return a readable ranked chart.');
  const days = period === 'month' ? 30 : 7;
  const date = time => new Date(time).toISOString().slice(0, 10);
  const sourceUrl = justWatchChartUrl(kind, period);
  return {
    id: kind, kind, title: kind === 'movies' ? 'Trending movies' : 'Trending series', period,
    periodLabel: 'Last ' + days + ' days', periodStart: date(published - (days - 1) * DAY_MS),
    periodEnd: date(published), publishedAt: date(published), chartUpdatedAt: new Date(published).toISOString(), chartProvider: 'justwatch',
    source: JUSTWATCH_SOURCE, sourceUrl, sourceUrls: [sourceUrl], curated: false, stale: false,
    rankingMethod: 'Global JustWatch activity: streaming offer clicks, watchlists and watched titles.',
    description: 'Global JustWatch activity over the last ' + days + ' days.',
    items: items.sort((a, b) => a.chartRank - b.chartRank),
  };
}

export function parseJustWatchRecentMovies(html, {year,plainText}) {
  const details=titleDetails(html,'movies'),seen=new Set(),items=[];
  for(const [,tag,card] of html.matchAll(/<a\b([^>]*\bclass="[^"]*\btitle-list-grid__item--link\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi)){
    const titlePath=attributes(tag).href,info=details.get(titlePath);
    if(!info||info.year!==year||!/^\/us\/movie\/[a-z0-9%-]+\/?$/i.test(titlePath)||
      new URL(titlePath,ORIGIN).pathname!==titlePath||seen.has(titlePath)||typeof info.title!=='string')continue;
    const title=plainText(info.title).slice(0,180);
    if(!title)continue;
    seen.add(titlePath);
    items.push({id:titleId(titlePath),title,year,kind:'movies',isSeries:false,confidence:1,overview:plainText(info.overview).slice(0,900),runtime:info.runtime,genres:info.genres,
      posterRemote:posterFromRow(card),source:'JustWatch US',
      sourceUrl:new URL(titlePath,ORIGIN).href,attribution:'JustWatch popularity listing. Artwork rights belong to their owners.'});
    if(items.length===48)break;
  }
  if(items.length<4)throw Error('JustWatch did not return a readable release-year shelf.');
  const sourceUrl=justWatchReleaseUrl(year);
  return {id:'new-movies',category:'movies',kind:'movies',title:'Popular '+year+' movies',periodLabel:year+' releases',
    source:'JustWatch US',sourceUrl,sourceUrls:[sourceUrl],chartProvider:'justwatch-releases',
    rankingMethod:'Popularity order from the JustWatch US movie catalog, filtered to the original release year.',
    description:'This year’s movies, ranked by popularity on JustWatch US.',
    items,curated:false,stale:false};
}
