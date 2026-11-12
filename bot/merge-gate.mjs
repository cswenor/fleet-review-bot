// Merge holds shared by the trusted merge-gate workflow and review status text.
// A PR is held while it has the `hold` label or an unticked `- [ ] Gate: <condition>`
// task-list line in its body. Every such line counts, including lines inside HTML
// comments or code blocks: hiding Markdown regions line by line misses visible gates,
// so the parser fails closed and the check summary lists every gate it found.
// The workflow loads trusted pinned source, never PR-controlled code.
export const HOLD_LABEL = "hold";
// A list or task item (optionally blockquoted, ordered or nested on the same line, as in
// `- - [ ] Gate:`) whose checkbox is followed by `Gate:` on the same line or at the
// start of the item's next line.
const GATE_ITEM =
  /^[ \t]*(?:(?:>|[-*+][ \t]|\d{1,9}[.)][ \t])[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?:[ \t]+|[ \t]*\r?\n[ \t>]*)gate:([^\r\n]*)/gimu;

export function mergeGate(pr) {
  const held = (pr?.labels ?? []).some((label) => label?.name?.toLowerCase() === HOLD_LABEL);
  const gates = [...(pr?.body ?? "").matchAll(GATE_ITEM)].map((match) => ({
    ticked: match[1] !== " ",
    condition: match[2].trim(),
  }));
  return { held, gates, pass: !held && gates.every((gate) => gate.ticked) };
}

export function mergeGateSummary({ held, gates, pass }) {
  const lines = [
    `## merge-gate: ${pass ? "pass" : "blocked"}`,
    "",
    held ? "- `hold` label: present (blocks merge)" : "- `hold` label: absent",
  ];
  if (!gates.length) lines.push("- No `Gate:` checkboxes in the PR body.");
  for (const gate of gates) {
    lines.push(
      `- ${gate.ticked ? "ticked" : "UNTICKED"}: ${gate.condition || "(no condition text)"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
