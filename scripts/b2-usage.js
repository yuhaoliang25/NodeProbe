#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const mode = process.argv[2];
const files = process.argv.slice(3).filter(Boolean);
const stateFile = 'data/.b2-usage-github.json';

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return null; }
}
function fmt(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MiB';
}
function sumFiles(list) {
  let bytes = 0, count = 0;
  for (const file of list) {
    const size = sizeOf(file);
    if (size === null) continue;
    bytes += size;
    count++;
  }
  return { bytes, count };
}

if (mode === 'snapshot-downloads') {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const d = sumFiles(files);
  const old = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  old.downloadBytes = d.bytes;
  old.downloadFiles = d.count;
  old.downloadExpected = files.length;
  fs.writeFileSync(stateFile, JSON.stringify(old));
} else if (mode === 'summary') {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const u = sumFiles(files);
  const dBytes = saved.downloadBytes || 0;
  const dFiles = saved.downloadFiles || 0;
  const dExpected = saved.downloadExpected || 0;
  console.log('[B2 usage] download=' + fmt(dBytes) + ' (' + dFiles + '/' + dExpected + ' files)' +
    ' | upload=' + fmt(u.bytes) + ' (' + u.count + '/' + files.length + ' files)' +
    ' | file-ops=' + (dExpected + files.length) + ' expected');
} else if (mode === 'downloads-only') {
  const d = sumFiles(files);
  console.log('[B2 usage] download=' + fmt(d.bytes) + ' (' + d.count + '/' + files.length + ' files)' +
    ' | upload=0 B | file-ops=' + files.length + ' expected');
} else {
  console.error('usage: b2-usage.js snapshot-downloads <files...> | summary <upload-files...> | downloads-only <download-files...>');
  process.exit(2);
}
