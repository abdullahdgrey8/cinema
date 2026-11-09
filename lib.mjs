import path from 'node:path';
import {createHash} from 'node:crypto';
export const media = /\.(mp4|m4v|webm|mkv|avi|mov|ts|m2ts|mpg|mpeg)$/i;
export function classify(name, category = '') {
  name=String(name||'');const c = String(category||'').toLowerCase();
  if (/anime/.test(c)) return 'anime';
  if (/tv|show|series/.test(c) || /\bS\d{1,2}E\d{1,3}\b|\b\d{1,2}x\d{2}\b/i.test(name)) return 'tv';
  if (/movie|film/.test(c)) return 'movies';
  if (/music|book|game|software|picture|adult/.test(c) || /\.(epub|pdf|mobi|m4b|mp3|flac|exe|iso|zip|rar)$/i.test(name)) return 'other';
  if (/^\[[^\]]+\].*(?:\b\d{2,3}\b|1080|720|HEVC)/i.test(name))return 'anime';
  if (/\b(?:19|20)\d{2}\b/.test(name.replace(/[._]/g,' ')) && /2160p|1080p|720p|WEB.?DL|WEBRip|BluRay|BRRip|x26[45]|HEVC|H\.?26[45]/i.test(name))return 'movies';
  return 'other';
}
export function title(name) {
  return String(name||'Untitled').replace(/\.(mp4|mkv|avi|webm|m4v)$/i, '').replace(/[._]/g, ' ').replace(/\b(2160p|1080p|720p|480p|WEB[- ]?DL|WEBRip|BluRay|BDRip|x264|x265|HEVC)\b.*$/i, '').replace(/[\s\[({-]+$/g,'').trim();
}
export function titleKey(name){return title(name).replace(/^\[[^\]]+\]\s*/,'').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();}
export function magnetHashes(url){
  let u;try{u=new URL(url);}catch{return [];}
  if(u.protocol!=='magnet:')return [];
  return u.searchParams.getAll('xt').flatMap(xt=>{
    let m=/^urn:btih:([a-f\d]{40})$/i.exec(xt);if(m)return [m[1].toLowerCase()];
    m=/^urn:btmh:1220([a-f\d]{64})$/i.exec(xt);if(m)return [m[1].toLowerCase()];
    m=/^urn:btih:([a-z2-7]{32})$/i.exec(xt);if(!m)return [];
    let acc=0,bits=0,out=[];for(const ch of m[1].toUpperCase()){acc=(acc<<5)|'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);bits+=5;if(bits>=8){bits-=8;out.push((acc>>>bits)&255);}}return [Buffer.from(out).toString('hex')];
  });
}
export function torrentIdentity(url){const hs=magnetHashes(url);return hs.length?'hash:'+hs.sort().join(':'):'url:'+createHash('sha256').update(String(url)).digest('hex');}
export function validReleaseLink(value){
  if(typeof value!=='string'||value.length>8192)return false;
  const url=URL.parse(value);
  return Boolean(url&&!url.username&&!url.password&&(url.protocol==='magnet:'?magnetHashes(value).length:
    ['http:','https:'].includes(url.protocol)));
}
export function nonVideoRelease(name){
  return /\.(?:srt|vtt|ass|ssa|nfo|txt|pdf|epub|mobi|mp3|flac|m4a|aac|mka|wav|zip|rar|7z|exe|iso)$/i.test(String(name||''));
}
export function pluginGroups(plugin){
  const cats=(plugin.supportedCategories||[]).map(c=>c.id);const groups=['movies','tv','anime'].filter(c=>cats.includes(c));
  if(!groups.length || cats.some(c=>!['all','movies','tv','anime'].includes(c)))groups.push('misc');
  return groups;
}
export function statusLabel(t){
  const s=t.state||'';if(s==='error')return 'Download error';if(s==='missingFiles')return 'Files missing';if(/checking/i.test(s))return 'Checking files';if(/moving/i.test(s))return 'Moving files';
  if(/meta/i.test(s))return /stopped|paused/i.test(s)?'Metadata paused':'Finding peers & metadata';
  if(/paused|stopped/i.test(s))return t.progress>=1?'Paused · downloaded':'Paused';if(/queued/i.test(s))return 'Queued';if(t.progress>=1)return 'Downloaded';if(/stalled/i.test(s))return 'Waiting for peers';return 'Downloading';
}
export function rangeFor(header, size) {
  if (!header) return {start: 0, end: size - 1, partial: false};
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) throw Error('Invalid range');
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) throw Error('Invalid range');
  return {start, end, partial: true};
}
export function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
