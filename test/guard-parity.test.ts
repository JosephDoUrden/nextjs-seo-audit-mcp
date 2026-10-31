import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/guard.js';

// The CLI's own isPrivateAddress, which its package does not export. Loaded by file path.
const cliRoot = dirname(createRequire(import.meta.url).resolve('vercel-seo-audit/package.json'));
const cli = (await import(pathToFileURL(join(cliRoot, 'dist/utils/url.js')).href)) as {
  isPrivateAddress(hostname: string): boolean;
};

/** Hosts as `new URL().hostname` prints them, or as DNS answers them, with the expected verdict. */
const TABLE: [string, boolean][] = [
  ['localhost', true],
  ['app.localhost', true],
  ['localhost.', true],
  ['example.com', false],
  ['127.0.0.1', true],
  ['10.1.2.3', true],
  ['172.16.0.1', true],
  ['172.32.0.1', false],
  ['192.168.1.1', true],
  ['169.254.169.254', true],
  ['100.64.0.1', true],
  ['100.128.0.1', false],
  ['0.0.0.0', true],
  ['0.1.2.3', true],
  ['198.18.0.1', true],
  ['198.19.255.255', true],
  ['198.20.0.1', false],
  ['240.0.0.1', true],
  ['255.255.255.255', true],
  ['8.8.8.8', false],
  ['93.184.215.14', false],
  ['[::]', true],
  ['[::1]', true],
  ['::1', true],
  ['[::ffff:7f00:1]', true],
  ['::ffff:10.0.0.1', true],
  ['[::ffff:808:808]', false],
  ['[::ffff:0:a9fe:a9fe]', true],
  ['[::ffff:0:808:808]', false],
  ['[64:ff9b::a9fe:a9fe]', true],
  ['[64:ff9b::a00:1]', true],
  ['[64:ff9b::808:808]', false],
  ['[2002:a9fe:a9fe::1]', true],
  ['[2002:c0a8:101::1]', true],
  ['[2002:808:808::1]', false],
  ['[fd00::1]', true],
  ['[fe80::1]', true],
  ['fe80::1%en0', true],
  ['[fec0::1]', true],
  ['[2606:4700::1111]', false],
];

// The CLI is adding the same ranges. Until a release has them, its copy disagrees on those
// rows by design, so the parity check waits for it rather than failing.

describe('isPrivateAddress', () => {
  it('has a 40-row table', () => {
    expect(TABLE).toHaveLength(40);
  });

  it.each(TABLE)('%s is private: %s', (host, expected) => {
    expect(isPrivateAddress(host)).toBe(expected);
  });

  it(
    'agrees with the CLI copy on every row',
    () => {
      const differ = TABLE.filter(([host]) => isPrivateAddress(host) !== cli.isPrivateAddress(host)).map(([h]) => h);
      expect(differ).toEqual([]);
    },
  );
});
