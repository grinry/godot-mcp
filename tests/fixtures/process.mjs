const mode = process.argv[2];
if (mode === 'stubborn') {
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
