import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const outputPath = join(root, 'THIRD_PARTY_NOTICES.md');
const checkOnly = process.argv.includes('--check');

function command(binary, args) {
  let executable = binary;
  let commandArgs = args;
  if (process.platform === 'win32' && binary === 'pnpm') {
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath && existsSync(npmExecPath)) {
      executable = process.execPath;
      commandArgs = [npmExecPath, ...args];
    } else {
      const nativePnpm = (process.env.PATH ?? '')
        .split(delimiter)
        .map((directory) => join(directory, 'pnpm.exe'))
        .find(existsSync);
      if (nativePnpm) {
        executable = nativePnpm;
      } else {
        if (args.some((argument) => !/^[a-zA-Z0-9:._/-]+$/.test(argument))) {
          throw new Error('Refusing to pass an unsafe argument to pnpm.cmd.');
        }
        executable = process.env.ComSpec ?? 'cmd.exe';
        commandArgs = ['/d', '/s', '/c', `pnpm.cmd ${args.join(' ')}`];
      }
    }
  }
  const result = spawnSync(executable, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${binary} ${args.join(' ')} failed:\n` +
        `${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  }
  return result.stdout;
}

function noticeFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name),
    )
    .map((entry) => join(directory, entry.name))
    .filter((path) => readFileSync(path).byteLength <= 2 * 1024 * 1024);
}

function normalizeText(value) {
  return value.replaceAll('\r\n', '\n').trim() + '\n';
}

function escapeCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

const npmReport = JSON.parse(
  command('pnpm', ['licenses', 'list', '--json']),
);
const cargoReport = JSON.parse(
  command('cargo', [
    'metadata',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--locked',
    '--format-version',
    '1',
  ]),
);

const packages = [];
for (const [license, entries] of Object.entries(npmReport)) {
  for (const entry of entries) {
    for (const version of entry.versions) {
      packages.push({
        ecosystem: 'npm',
        name: entry.name,
        version,
        license,
        source: entry.homepage ?? '',
        authors: entry.author ?? '',
        directories: entry.paths,
      });
    }
  }
}

for (const entry of cargoReport.packages) {
  if (entry.name === 'canvink') continue;
  packages.push({
    ecosystem: 'Cargo',
    name: entry.name,
    version: entry.version,
    license: entry.license ?? 'UNKNOWN',
    source: entry.repository ?? entry.homepage ?? '',
    authors: (entry.authors ?? []).join(', '),
    directories: [dirname(entry.manifest_path)],
  });
}

packages.sort((left, right) =>
  [
    left.ecosystem,
    left.name.toLocaleLowerCase(),
    left.version,
  ].join(':').localeCompare(
    [right.ecosystem, right.name.toLocaleLowerCase(), right.version].join(':'),
  ),
);

const noticeGroups = new Map();
const packagesWithoutNoticeFile = [];
for (const entry of packages) {
  const files = [...new Set(entry.directories.flatMap(noticeFiles))];
  if (files.length === 0) {
    packagesWithoutNoticeFile.push(entry);
    continue;
  }
  for (const path of files) {
    const text = normalizeText(readFileSync(path, 'utf8'));
    const hash = createHash('sha256').update(text).digest('hex');
    const group = noticeGroups.get(hash) ?? {
      text,
      packages: new Set(),
    };
    group.packages.add(`${entry.ecosystem}:${entry.name}@${entry.version}`);
    noticeGroups.set(hash, group);
  }
}

const lines = [
  '# Third-party notices',
  '',
  'This file is generated from the exact npm and Cargo lock graphs used by Canvink.',
  'It is distributed with the application together with the Canvink AGPL license.',
  'The inventory records declared SPDX expressions and upstream sources. The',
  'following sections reproduce license and notice files shipped by dependencies.',
  '',
  '## Dependency inventory',
  '',
  '| Ecosystem | Package | Version | Declared license | Upstream |',
  '| --- | --- | --- | --- | --- |',
];

for (const entry of packages) {
  const upstream = entry.source
    ? `[source](${entry.source.replaceAll(')', '%29')})`
    : '';
  lines.push(
    `| ${escapeCell(entry.ecosystem)} | ${escapeCell(entry.name)} | ` +
      `${escapeCell(entry.version)} | ${escapeCell(entry.license)} | ${upstream} |`,
  );
}

if (packagesWithoutNoticeFile.length > 0) {
  lines.push(
    '',
    '## Packages without a bundled top-level notice file',
    '',
    'For these packages, the declared license expression and upstream attribution',
    'in the inventory apply. Their source distributions remain available upstream.',
    '',
  );
  for (const entry of packagesWithoutNoticeFile) {
    lines.push(
      `- ${entry.ecosystem}:${entry.name}@${entry.version}, ${entry.license}` +
        (entry.authors ? `, ${entry.authors}` : ''),
    );
  }
}

lines.push('', '## Distributed license and notice texts', '');
for (const [hash, group] of [...noticeGroups.entries()].sort((left, right) =>
  [...left[1].packages][0].localeCompare([...right[1].packages][0]),
)) {
  lines.push(
    '<details>',
    `<summary>${[...group.packages].sort().map(escapeCell).join(', ')}</summary>`,
    '',
    `Notice text SHA-256: \`${hash}\``,
    '',
    '~~~~text',
    group.text.trimEnd(),
    '~~~~',
    '',
    '</details>',
    '',
  );
}

const generated = lines.join('\n').trimEnd() + '\n';
if (checkOnly) {
  if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== generated) {
    console.error(
      'THIRD_PARTY_NOTICES.md is stale. Run pnpm notices:generate and commit it.',
    );
    process.exitCode = 1;
  } else {
    console.log(`Third-party notices are current for ${packages.length} packages.`);
  }
} else {
  writeFileSync(outputPath, generated);
  console.log(
    `Wrote THIRD_PARTY_NOTICES.md for ${packages.length} packages and ` +
      `${noticeGroups.size} distinct notice texts.`,
  );
}
