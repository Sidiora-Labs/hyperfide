import { pathToFileURL } from 'node:url';

if (process.env.HYPERFIDE_BLAXEL_LIVE !== '1') {
  console.log('SKIP Blaxel live smoke (HYPERFIDE_BLAXEL_LIVE is not 1)');
} else {
  const resolverModule = process.argv[2];
  if (!resolverModule) throw new Error('Pass a module exporting resolveCredentials backed by plugin settings for live smoke');
  const { resolveCredentials } = await import(pathToFileURL(resolverModule).href);
  const { runLiveSmoke } = await import('./live-smoke-runner.ts');
  await runLiveSmoke(resolveCredentials);
}
