import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyScenePackets} from '../scene-clip.mjs';

const targetMs = 1100;
const asTime = ticks => ({n:BigInt(ticks),d:1000n});
const sample = (number, start, pts, sync = false) => ({number,start,end:start+1,sync,
  decodeTime:pts,compositionTime:pts,duration:200,presentationTime:asTime(pts),presentationEnd:asTime(pts+200)});
function fixture() {
  const bytes = Buffer.from([99,99,101,102,99,99,111,112]);
  const read = (start,end) => bytes.subarray(start,end);
  const video = [sample(10,0,1000,true),sample(11,1,1200),sample(12,2,1400),sample(13,3,1600)];
  const audio = [sample(20,4,1000,true),sample(21,5,1200,true),sample(22,6,1400,true),sample(23,7,1600,true)];
  const scene = {keyframe:video[0],video:{timescale:1000,samples:video},audio:{timescale:1000,samples:audio}};
  const packet = (s,stream,i) => ({stream_index:stream,dts:s.decodeTime-1000,pts:s.compositionTime-1000,
    size:'1',duration:200,flags:s.sync?'K_':'__',pos:String(i+20),
    data_hash:'SHA256:'+createHash('sha256').update(read(s.start,s.end)).digest('hex')});
  const streams = [{index:0,codec_type:'video',codec_name:'h264',time_base:'1/1000',duration:'0.800000'},
    {index:1,codec_type:'audio',codec_name:'aac',time_base:'1/1000',duration:'0.800000'}];
  return {scene,read,targetMs,probe:{streams,packets:[...video.map((s,i)=>packet(s,0,i)),...audio.map((s,i)=>packet(s,1,i+4))]}};
}

test('packet proof translates the requested time on consecutive verified streams', () => {
  const proof = verifyScenePackets(fixture());
  assert.equal(proof.seekSeconds,.1);
  assert.equal(proof.packetCount,8);
});

test('a same-payload duplicate with the wrong cadence cannot substitute for its next ordinal', () => {
  const input = fixture();
  input.probe.packets[1] = {...input.probe.packets[0],flags:'__'};
  assert.throws(()=>verifyScenePackets(input),/order|cadence/i);
});

test('only the exact last AAC packet position can use corroborated raw timing', () => {
  const input = fixture();
  input.probe.packets[7].duration = 201;
  input.terminalAudio = {timescale:1000,duration:200,start:27,end:28};
  assert.equal(verifyScenePackets(input).seekSeconds,.1);
  input.terminalAudio.start = 26;
  assert.throws(()=>verifyScenePackets(input),/order|cadence/i);
});

test('a valid prefix without enough picture or audio after the request fails', () => {
  const input = fixture();
  input.probe.packets.splice(-2);
  assert.throws(()=>verifyScenePackets(input),/cover/i);
});
