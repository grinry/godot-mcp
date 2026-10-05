import { readFile, writeFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = new URL('../.codex-plugin/plugin.json', import.meta.url);
const source = await readFile(manifest, 'utf8');
await writeFile(manifest, source.replace(/("version"\s*:\s*")[^"]+(")/, `$1${pkg.version}$2`));
