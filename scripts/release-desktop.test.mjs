import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildLatestJson, installerName, nextVersion, setVersion } from './release-desktop.mjs';

test('nextVersion moves patch and minor and accepts an explicit version', () => {
  assert.equal(nextVersion('0.3.0-beta.1', 'patch'), '0.3.1');
  assert.equal(nextVersion('0.3.1', 'patch'), '0.3.2');
  assert.equal(nextVersion('0.3.1', 'minor'), '0.4.0');
  assert.equal(nextVersion('0.3.1', '1.0.0'), '1.0.0');
  assert.throws(() => nextVersion('0.3.1', 'big'));
});

test('latest.json points at the versioned installer and carries the signature', () => {
  const feed = buildLatestJson({
    version: '0.3.1',
    signature: 'SIG\n',
    baseUrl: 'https://canvink.example.com/download/',
    pubDate: new Date('2026-10-01T10:00:00Z'),
  });
  assert.equal(feed.version, '0.3.1');
  assert.equal(feed.pub_date, '2026-10-01T10:00:00.000Z');
  assert.deepEqual(feed.platforms['windows-x86_64'], {
    signature: 'SIG',
    url: `https://canvink.example.com/download/${installerName('0.3.1')}`,
  });
});

test('setVersion updates every file that carries the version and keeps the release marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvink-release-'));
  mkdirSync(join(root, 'src-tauri'));
  for (const file of ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.lock']) {
    cpSync(file, join(root, file));
  }
  setVersion(root, '9.8.7');
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '9.8.7');
  assert.equal(JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version, '9.8.7');
  assert.match(readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8'), /^version = "9\.8\.7"$/m);
  assert.match(
    readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8'),
    /name = "canvink"\nversion = "9\.8\.7" # x-release-please-version/,
  );
});
