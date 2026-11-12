import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readBuilderSecrets, appJwt } from '../scripts/builder/builder.mjs';

test('Builder credentials require explicit valid RSA inputs and never expose rejected values', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const encoded = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
  const env = { BUILDER_GITHUB_APP_CLIENT_ID: 'IvSyntheticClient', BUILDER_GITHUB_APP_PRIVATE_KEY_B64: encoded };
  const credentials = await readBuilderSecrets({ env });
  const jwt = appJwt({ ...credentials, now: () => 1000000 });
  assert.equal(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).iss, env.BUILDER_GITHUB_APP_CLIENT_ID);
  const { privateKey: ec } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (const invalid of [{}, { ...env, BUILDER_GITHUB_APP_CLIENT_ID: 'rejected-client-value' },
    { ...env, BUILDER_GITHUB_APP_PRIVATE_KEY_B64: 'rejected-key-value' },
    { ...env, BUILDER_GITHUB_APP_PRIVATE_KEY_B64: Buffer.from(ec.export({ type: 'pkcs8', format: 'pem' })).toString('base64') }]) {
    await assert.rejects(readBuilderSecrets({ env: invalid }), { message: 'builder refused: builder_secret_unavailable' });
  }
});

test('standalone Builder gh entrypoint executes without an absent sibling wrapper', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'builder-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    REVIEW_BOT_BUILDER_REAL_GH: process.execPath };
  assert.equal(spawnSync('git', ['init', '-q', root], { env }).status, 0);
  const cli = fileURLToPath(new URL('../scripts/builder/builder.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'gh', '--version'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.version);
});
