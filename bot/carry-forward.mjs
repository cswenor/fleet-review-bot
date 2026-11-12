import { createHash } from 'node:crypto';

// The stricter, approved comparison retains every diff byte except hunk start offsets.
// latin1 is a byte-preserving round trip, including non-UTF-8 source contents.
export function fingerprintDiff(bytes) {
  const normalized = bytes.toString('latin1').replace(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/gmu,
    (_, oldCount = '', newCount = '') => `@@ -0${oldCount} +0${newCount} @@`);
  return createHash('sha256').update(Buffer.from(normalized, 'latin1')).digest('hex');
}

// --verbatim implies --stable but preserves whitespace, including indentation:
// https://git-scm.com/docs/git-patch-id#Documentation/git-patch-id.txt---verbatim
export async function canCarryForward({ git, patchFingerprint, mainSha, priorHead, priorBase, headSha }) {
  if (![mainSha, priorHead, priorBase, headSha].every((sha) => /^[0-9a-f]{40}$/u.test(sha ?? ''))) return false;
  const version = /^git version (\d+)\.(\d+)/u.exec(await git('--version'));
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 39)) return false;
  try { await git('patch-id', '--verbatim'); } catch { return false; }
  if (headSha === priorHead) return true;
  const commits = (await git('rev-list', '--first-parent', `${priorHead}..${headSha}`)).trim()
    .split('\n').filter(Boolean).reverse();
  if (!commits.length) return false;
  let expectedParent = priorHead;
  for (const commit of commits) {
    const parents = (await git('show', '-s', '--format=%P', commit)).trim().split(' ');
    if (parents.length < 2 || parents[0] !== expectedParent) return false;
    for (const incoming of parents.slice(1)) {
      if ((await git('merge-base', incoming, mainSha)).trim() !== incoming) return false;
    }
    expectedParent = commit;
  }
  if (expectedParent !== headSha) return false;
  const newBase = (await git('merge-base', mainSha, headSha)).trim();
  return await patchFingerprint(priorBase, priorHead) === await patchFingerprint(newBase, headSha);
}
