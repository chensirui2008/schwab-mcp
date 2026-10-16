// Bundle the software authenticator only; production code never uses it outside /__test.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await build({ entryPoints: ['test/acceptance/browser-shim.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022' });
const shim = browser.outputFiles[0].text.replaceAll('</script', '<\\/script');
await mkdir('.wrangler/oauth-test', { recursive: true });
await writeFile('.wrangler/oauth-test/browser-shim.js', 'export default ' + JSON.stringify(shim) + ';\n');
