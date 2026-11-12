import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeGate, mergeGateSummary } from './merge-gate.mjs';

const gate = (body, labels = []) => mergeGate({ body, labels: labels.map((name) => ({ name })) });

test('ticked gates pass, any unticked gate blocks', () => {
  assert.deepEqual(gate('- [x] Gate: prod proof recorded'), { held: false, gates: [{ ticked: true, condition: 'prod proof recorded' }], pass: true });
  assert.deepEqual(gate('- [ ] Gate: prod proof recorded'), { held: false, gates: [{ ticked: false, condition: 'prod proof recorded' }], pass: false });
  const mixed = gate('Intro\n- [x] Gate: migration applied\n- [ ] Gate: prod proof\n');
  assert.equal(mixed.pass, false);
  assert.deepEqual(mixed.gates, [{ ticked: true, condition: 'migration applied' }, { ticked: false, condition: 'prod proof' }]);
});

test('a PR without gates or labels passes', () => {
  assert.deepEqual(gate('- [ ] CI is green\n- [x] Docs updated'), { held: false, gates: [], pass: true });
  assert.deepEqual(mergeGate({ body: null }), { held: false, gates: [], pass: true });
  assert.deepEqual(mergeGate(undefined), { held: false, gates: [], pass: true });
});

test('the hold label blocks regardless of gates and case', () => {
  for (const label of ['hold', 'Hold']) {
    const result = gate('- [x] Gate: done', [label, 'bug']);
    assert.equal(result.held, true);
    assert.equal(result.pass, false);
  }
  assert.equal(gate('', ['on-hold']).pass, true);
});

test('checkbox variants are recognised; prose mentions and malformed boxes are not', () => {
  const body = '* [ ] gate: a\r\n  + [X] GATE: b\r\n    - [ ]   Gate:c\r\n- [ ] Gate:';
  assert.deepEqual(gate(body).gates, [
    { ticked: false, condition: 'a' }, { ticked: true, condition: 'b' }, { ticked: false, condition: 'c' }, { ticked: false, condition: '' },
  ]);
  assert.equal(gate('Text with `- [ ] Gate: <condition>` inline\n- [] Gate: malformed\n- [ ]Gate: no space').gates.length, 0);
});

test('blockquoted, ordered and continuation-line task items are gates', () => {
  assert.deepEqual(gate('> - [ ] Gate: quoted\n1. [x] Gate: first\n2) [ ] Gate: second\n- [ ]\r\n  Gate: next line\n> - [x]\n> Gate: quoted next').gates, [
    { ticked: false, condition: 'quoted' }, { ticked: true, condition: 'first' }, { ticked: false, condition: 'second' },
    { ticked: false, condition: 'next line' }, { ticked: true, condition: 'quoted next' },
  ]);
  assert.deepEqual(gate('- [ ]\n- [ ] Gate: own line').gates, [{ ticked: false, condition: 'own line' }]);
  assert.deepEqual(gate('- - [ ] Gate: nested\n- [x] Gate: adjacent\n> 1. * [ ] Gate: deep').gates, [
    { ticked: false, condition: 'nested' }, { ticked: true, condition: 'adjacent' }, { ticked: false, condition: 'deep' },
  ]);
});

test('gates inside HTML comments and code blocks still block (fail closed)', () => {
  assert.equal(gate('<!--\n- [ ] Gate: commented\n-->').pass, false);
  assert.equal(gate('```md\n- [ ] Gate: fenced\n```').pass, false);
  assert.equal(gate('Opening `<!--`\n\n- [ ] Gate: production proof\n\nClosing `-->`').pass, false);
});

test('summary lists the hold label and every gate state', () => {
  const blocked = mergeGateSummary(gate('- [ ] Gate: prod proof\n- [x] Gate: migration\n- [ ] Gate:', ['hold']));
  assert.match(blocked, /^## merge-gate: blocked\n/u);
  assert.match(blocked, /- `hold` label: present \(blocks merge\)/u);
  assert.match(blocked, /- UNTICKED: prod proof\n- ticked: migration\n- UNTICKED: \(no condition text\)\n$/u);
  const passed = mergeGateSummary(gate('No gates here'));
  assert.match(passed, /^## merge-gate: pass\n/u);
  assert.match(passed, /- `hold` label: absent\n- No `Gate:` checkboxes in the PR body\.\n$/u);
});
