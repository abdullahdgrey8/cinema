import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicWriteLocalJson} from './source-memory.mjs';

const controlCharacters=/[\u0000-\u001f\u007f]/;

function problem(message, status=400) {
  return Object.assign(Error(message), {status,code:'download-folder'});
}

function localAbsoluteFolder(value) {
  if (typeof value!=='string' || value.length>1024 || controlCharacters.test(value)) return false;
  if (process.platform!=='win32') return path.isAbsolute(value);
  return /^[A-Za-z]:[\\/]/.test(value) && !/[:*?"<>|]/.test(value.slice(2));
}

export async function verifyDownloadFolder(folder, {unchanged=false}={}) {
  if (!localAbsoluteFolder(folder)) throw problem('Enter the full path to a folder on a local drive.');

  let resolved;
  try {
    resolved=await fs.realpath(folder);
    if (!localAbsoluteFolder(resolved) || !(await fs.stat(resolved)).isDirectory()) throw Error();
  } catch {
    throw problem('Cinema couldn’t open this folder. Check that the folder and drive are available.');
  }
  if (unchanged && folder!==resolved) {
    throw problem('The saved download folder now points somewhere else. Check Download location in Settings.');
  }

  try {
    const probePath=path.join(resolved,'.cinema-write-'+randomUUID());
    const probe=await fs.open(probePath,'wx');
    try {
      await probe.writeFile('0');
    } finally {
      try { await probe.close(); } finally { await fs.unlink(probePath); }
    }
    await fs.mkdir(probePath);
    await fs.rmdir(probePath);
  } catch {
    throw problem('Cinema needs permission to write to this folder. Choose a writable folder.');
  }
  return resolved;
}

export async function createDownloadLocation(local) {
  const file=path.join(local,'download-location.json');
  let selected, writing=Promise.resolve();
  try {
    const saved=JSON.parse(await fs.readFile(file,'utf8'));
    if (saved?.path===null || localAbsoluteFolder(saved?.path)) selected=saved.path;
  } catch (error) {
    if (error.code==='ENOENT') selected=null;
  }

  function current() {
    if (selected===undefined) throw problem('Cinema couldn’t read the saved download location. Save a folder or use the qBittorrent default to reset it.',500);
    return {mode:selected===null?'default':'custom',path:selected};
  }

  function save(value) {
    const change=writing.catch(()=>{}).then(async()=>{
      const next=value===null?null:await verifyDownloadFolder(value);
      try {
        await atomicWriteLocalJson(file,{path:next});
      } catch {
        throw problem('Cinema couldn’t save the download location. Try again.',500);
      }
      selected=next;
      return current();
    });
    writing=change;
    return change;
  }
  return {current,save};
}
