import { spawn } from 'node:child_process';

const mode = process.argv[2];
if (mode === 'orphan' || mode === 'nested-resistant') {
  const nested = spawn(process.execPath, [process.argv[1], 'stubborn'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  nested.stdout.once('data', () => {
    console.log(`child:${nested.pid}`);
    nested.stdout.destroy();
    nested.unref();
    if (mode === 'nested-resistant') setInterval(() => {}, 1000);
  });
} else if (mode === 'nested') {
  const nested = spawn(process.execPath, [process.argv[1]], { stdio: 'ignore' });
  console.log(`child:${nested.pid}`);
  process.on('SIGTERM', () => nested.once('exit', () => process.exit(0)));
  setInterval(() => {}, 1000);
} else if (mode === 'argv') {
  console.log(JSON.stringify(process.argv.slice(3)));
} else if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  console.log('ready');
  setInterval(() => {}, 1000);
} else if (mode === 'log') {
  process.stdout.write('split');
  setTimeout(() => {
    process.stdout.write(' line\nlast');
    process.stderr.write('error tail');
  }, 20);
} else if (mode === 'flood') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
} else {
  setInterval(() => {}, 1000);
}
