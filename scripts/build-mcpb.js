import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packExtension } from '@anthropic-ai/mcpb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staging = await mkdtemp(join(tmpdir(), 'godot-mcp-bundle-'));
async function listTools(entry) {
  const client = new Client({ name: 'bundle-check', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, GODOT_PATH: process.execPath },
    stderr: 'ignore',
  });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map(({ name, description }) => ({ name, description }));
  } finally {
    await client.close();
  }
}
try {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'mcpb-manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  manifest.compatibility.runtimes.node = pkg.engines.node;
  const tools = await listTools(join(root, 'build', 'index.js'));
  manifest.tools = tools;
  await mkdir(join(staging, 'server'), { recursive: true });
  await build({
    entryPoints: [join(root, 'build', 'index.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: join(staging, 'server', 'index.js'),
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  await cp(join(root, 'build', 'scripts'), join(staging, 'server', 'scripts'), { recursive: true });
  await writeFile(
    join(staging, 'package.json'),
    JSON.stringify({ type: 'module', version: pkg.version }),
  );
  await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'));
  await cp(join(root, 'README.md'), join(staging, 'README.md'));
  const bundledTools = await listTools(join(staging, 'server', 'index.js'));
  if (JSON.stringify(bundledTools) !== JSON.stringify(tools))
    throw new Error('Bundled MCP tool list differs from npm build');
  await mkdir(join(root, 'dist'), { recursive: true });
  const output = join(root, 'dist', `godot-mcp-${pkg.version}.mcpb`);
  if (!(await packExtension({ extensionPath: staging, outputPath: output })))
    throw new Error('MCPB packing failed');
  console.log(`Created ${output}; verified ${tools.length} MCP tools`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
