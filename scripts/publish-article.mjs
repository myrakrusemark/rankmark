// Prepare a clean portfolio checkout; --publish also commits and pushes it.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const publish = args.includes('--publish');
const paths = args.filter(x => x !== '--publish');
if (paths.length !== 1 || paths[0].startsWith('--')) {
  throw new Error('Usage: node scripts/publish-article.mjs SITE_CHECKOUT [--publish]');
}
const site = resolve(paths[0]);
const git = (...params) => execFileSync('git', ['-C', site, ...params], { encoding: 'utf8' }).trim();
if (!existsSync(join(site, '.git'))) throw new Error('Expected a portfolio Git checkout');
if (!/^https:\/\/github.com\/myrakrusemark\/myrakrusemark\.com(?:\.git)?$|^git@github.com:myrakrusemark\/myrakrusemark\.com(?:\.git)?$/.test(git('remote', 'get-url', 'origin'))) {
  throw new Error('Destination must be the myrakrusemark.com repository');
}
if (git('status', '--porcelain')) throw new Error('Commit or stash existing site changes first');
if (publish) {
  if (git('branch', '--show-current') !== 'main') throw new Error('Publishing requires the main branch');
  git('pull', '--ff-only', 'origin', 'main');
}
execFileSync(process.execPath, [join(root, 'scripts/deploy.mjs'), '--dry'], { stdio: 'inherit' });
const destination = join(site, 'watermark');
// Replace only the generated article; all other portfolio content stays in place.
rmSync(destination, { recursive: true, force: true });
cpSync(join(root, 'web/dist'), destination, { recursive: true });
console.log(git('status', '--short'));
if (publish && git('status', '--porcelain', '--', 'watermark')) {
  git('add', '--', 'watermark');
  git('commit', '-m', 'Update watermark article');
  console.log(git('push', 'origin', 'main'));
} else {
  console.log(publish ? 'Article is already current.' : 'Prepared. Review the watermark/ changes before committing.');
}
