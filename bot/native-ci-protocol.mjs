// Scheduling hints only: never merge, test, artifact, or deployment proof.
export const NATIVE_ADMISSION_VARIABLE = 'CI_NATIVE_ADMISSION_ENABLED';
export const NATIVE_ADMISSION_CHECK = 'native-ci-admission';
export const NATIVE_ADMISSION_JOB = 'Native admission';
export const NATIVE_DEFERRED_STEP = 'Native execution deferred until selected';
export const NATIVE_EARLY_LABEL = 'native-early';
// Protected repository Review App identity; do not discover private App metadata with a job token.
export const NATIVE_REVIEW_APP = Object.freeze({ id: 5303336, slug: 'example-review' });

const SHA = /^[0-9a-f]{40}$/u;
export function nativeAdmissionExternalId(batch, headSha) {
  return `native-ci:${batch.id}:${batch.generation}:${headSha}`;
}

export function parseNativeAdmission(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || typeof value.repository !== 'string'
    || !/^[\w.-]+\/[\w.-]+$/u.test(value.repository)
    || typeof value.batch_id !== 'string' || !value.batch_id || value.batch_id.length > 128
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !SHA.test(value.base_sha) || !SHA.test(value.head_sha)) return null;
  if (value.kind === 'single') {
    if (!Number.isSafeInteger(value.pr_number) || value.pr_number < 1) return null;
  } else if (value.kind === 'batch') {
    if (typeof value.carrier_branch !== 'string' || !value.carrier_branch
      || value.carrier_branch.length > 255) return null;
  } else return null;
  return value;
}
