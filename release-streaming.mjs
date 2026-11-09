const GIB=1024**3;
const videoCodec={
  avc:/\b(?:[xh][ ._-]?264|AVC)\b/i,
  heavier:/\b(?:[xh][ ._-]?265|HEVC|AV1|VP9|XviD|DivX)\b/i,
};

// Release names and plugin seed counts are hints. Only the downloaded
// header and actual transfer rate can establish playable formats and speed.
export function streamingHint(row,kind,existing){
  const name=String(row.fileName||''),seeds=Number(row.nbSeeders),size=Number(row.fileSize);
  const resolution=name.match(/\b(2160p|1080p|720p|480p)\b/i)?.[1].toLowerCase()||
    (/\b(?:4k|UHD)\b/i.test(name)?'2160p':null);
  const pack=/\b(?:complete|batch|collection|S\d{1,2}\s*-\s*S\d{1,2})\b/i.test(name)||
    /\b(?:S\d{1,2}(?!E\d)\b|season[ ._-]*\d+\b)/i.test(name)&&!/\b(?:S\d{1,2}E\d{1,3}|\d{1,2}x\d{2})\b/i.test(name);
  const format=videoCodec.heavier.test(name)?'conversion-likely':videoCodec.avc.test(name)?'h264':'unknown';
  let score=Number.isFinite(seeds)&&seeds>0?18+Math.min(35,Math.log2(seeds+1)*4):seeds===0?-25:0;
  if(format==='h264')score+=10;
  if(format==='conversion-likely')score-=8;
  if(resolution==='2160p')score-=12;
  if(resolution==='720p'||resolution==='1080p')score+=3;
  if(!pack&&Number.isFinite(size)&&size>0){
    const ceiling=(kind==='anime'?.9:kind==='tv'?1.7:3.5)*GIB;
    if(size>ceiling)score-=Math.min(12,Math.log2(size/ceiling)*5);
    else if(size>=100*1024**2)score+=3;
  }
  if(existing)score+=existing.progress>=1?100:45;
  const label=existing?(existing.progress>=1?'Ready in library':'Already downloading'):
    seeds===0?'No seeders reported':pack?'Multiple episodes':
    format==='h264'?'H.264 · usually easier to play':format==='conversion-likely'?'May need video conversion':
    'Playback format unknown';
  return {score:Math.round(score),format,resolution,pack,label};
}
