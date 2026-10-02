#!/usr/bin/env node
// Desktop update release. The desktop app bundles the web build, so a new
// version reaches it as a signed NSIS installer that the app downloads from
// https://canvink.example.com/download/latest.json (see docs/desktop-updates.md).
//
//   node scripts/release-desktop.mjs bump <patch|minor|x.y.z>
//       Sets the version in package.json, src-tauri/Cargo.toml,
//       src-tauri/tauri.conf.json and src-tauri/Cargo.lock.
//   node scripts/release-desktop.mjs build [--out public/download] [--base-url URL] [--notes TEXT] [--secrets-stdin]
//       Runs on Windows. Builds the signed NSIS installer, copies it with
//       latest.json into --out.
//
// The signing key never lives in the repository: `build` takes it from the
// environment (TAURI_SIGNING_PRIVATE_KEY and _PASSWORD), from two lines on
// stdin (--secrets-stdin, used by scripts/release-desktop.sh) or, as a last
// resort, from the 1Password item below through `op`. Secret values are only
// handed to the Tauri build's environment and never printed.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'https://canvink.example.com/download';
export const OP_ITEM = 'op://agent/Canvink Tauri updater signing key';
/** The stable name behind the download button on the web app. */
export const STABLE_INSTALLER = 'Canvink_x64-setup.exe';
const PLATFORM = 'windows-x86_64';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** `patch` always moves to the next patch number and drops a prerelease tag. */
export function nextVersion(current, spec) {
  const match = SEMVER.exec(current);
  if (!match) throw new Error(`Current version "${current}" is not semver`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (spec === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (spec === 'minor') return `${major}.${minor + 1}.0`;
  if (!SEMVER.test(spec)) throw new Error(`Version "${spec}" must be patch, minor or x.y.z`);
  return spec;
}

export function installerName(version) {
  return `Canvink_${version}_x64-setup.exe`;
}

/** The feed the Tauri updater reads; `signature` is the content of the .sig file. */
export function buildLatestJson({ version, signature, baseUrl, notes = '', pubDate = new Date() }) {
  return {
    version,
    notes,
    pub_date: pubDate.toISOString(),
    platforms: {
      [PLATFORM]: {
        signature: signature.trim(),
        url: `${baseUrl.replace(/\/+$/, '')}/${installerName(version)}`,
      },
    },
  };
}

/** Rewrites the version in the four files that carry it; returns the changed paths. */
export function setVersion(root, version) {
  const edits = [
    ['package.json', /("version":\s*")[^"]+(")/, `$1${version}$2`],
    ['src-tauri/tauri.conf.json', /("version":\s*")[^"]+(")/, `$1${version}$2`],
    ['src-tauri/Cargo.toml', /^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`],
    [
      'src-tauri/Cargo.lock',
      /(name = "canvink"\r?\nversion = ")[^"]+(" # x-release-please-version)/,
      `$1${version}$2`,
    ],
  ];
  for (const [file, pattern, replacement] of edits) {
    const path = join(root, file);
    const before = readFileSync(path, 'utf8');
    if (!pattern.test(before)) throw new Error(`${file}: no version to replace`);
    writeFileSync(path, before.replace(pattern, replacement));
  }
  return edits.map(([file]) => file);
}

function readVersion(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function readStdinLines() {
  return readFileSync(0, 'utf8').split(/\r?\n/);
}

function opRead(field) {
  const result = spawnSync('op', ['read', `${OP_ITEM}/${field}`], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`op could not read "${field}"; set TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD or sign in to 1Password`);
  return result.stdout.trim();
}

function signingEnv(useStdin) {
  if (useStdin) {
    const [key, password] = readStdinLines();
    if (!key || !password) throw new Error('--secrets-stdin expects the private key and its password on two lines');
    return { TAURI_SIGNING_PRIVATE_KEY: key.trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password.trim() };
  }
  if (process.env.TAURI_SIGNING_PRIVATE_KEY && process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== undefined) return {};
  return {
    TAURI_SIGNING_PRIVATE_KEY: opRead('private key'),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: opRead('password'),
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function build(root, args) {
  if (process.platform !== 'win32') throw new Error('The NSIS installer is built on Windows');
  const version = readVersion(root);
  const out = resolve(root, option(args, '--out') ?? 'public/download');
  const baseUrl = option(args, '--base-url') ?? DEFAULT_BASE_URL;
  const env = { ...process.env, ...signingEnv(args.includes('--secrets-stdin')) };

  run('pnpm', ['install', '--frozen-lockfile'], { cwd: root, env });
  run('pnpm', ['tauri', 'build', '--bundles', 'nsis', '--config', 'src-tauri/tauri.updater.conf.json', '--ci', '--', '--locked'], { cwd: root, env });

  const bundleDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const installer = join(bundleDir, installerName(version));
  const signaturePath = `${installer}.sig`;
  if (!existsSync(installer) || !existsSync(signaturePath)) {
    throw new Error(`Expected ${installerName(version)} and its .sig in ${bundleDir}`);
  }

  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(out)) {
    if (/^Canvink_.+_x64-setup\.exe$/.test(name) && name !== installerName(version)) rmSync(join(out, name));
  }
  copyFileSync(installer, join(out, installerName(version)));
  copyFileSync(installer, join(out, STABLE_INSTALLER));
  const feed = buildLatestJson({
    version,
    signature: readFileSync(signaturePath, 'utf8'),
    baseUrl,
    notes: option(args, '--notes') ?? '',
  });
  writeFileSync(join(out, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);
  console.log(`Built Canvink ${version}: ${out}`);
}

function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const [command, ...args] = process.argv.slice(2);
  if (command === 'bump') {
    const version = nextVersion(readVersion(root), args[0] ?? 'patch');
    setVersion(root, version);
    console.log(version);
  } else if (command === 'build') {
    build(root, args);
  } else {
    console.error('Usage: release-desktop.mjs bump <patch|minor|x.y.z> | build [--out DIR] [--base-url URL] [--notes TEXT] [--secrets-stdin]');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
