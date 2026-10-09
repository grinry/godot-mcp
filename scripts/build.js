import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Make the build/index.js file executable
fs.chmodSync(path.join(__dirname, '..', 'build', 'index.js'), '755');

// Copy the scripts directory to the build directory
try {
  // Ensure the build/scripts directory exists
  fs.ensureDirSync(path.join(__dirname, '..', 'build', 'scripts'));

  fs.copySync(
    path.join(__dirname, '..', 'src', 'scripts'),
    path.join(__dirname, '..', 'build', 'scripts'),
  );
  const addon = path.join(__dirname, '..', 'build', 'scripts', 'annotation_addon');
  fs.copySync(path.join(__dirname, '..', 'LICENSE'), path.join(addon, 'license.txt'));
  const files = Object.fromEntries(
    fs
      .readdirSync(addon)
      .filter((name) => /\.(gd|tscn|cfg|txt)$/.test(name))
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(addon, name)))
          .digest('hex'),
      ]),
  );
  fs.writeJsonSync(
    path.join(addon, 'manifest.json'),
    {
      version: fs
        .readFileSync(path.join(addon, 'plugin.cfg'), 'utf8')
        .match(/^version="([^"]+)"$/m)[1],
      schemaVersion: 1,
      files,
    },
    { spaces: 2 },
  );
} catch (error) {
  console.error('Error copying scripts:', error);
  process.exit(1);
}

console.log('Build scripts completed successfully!');
