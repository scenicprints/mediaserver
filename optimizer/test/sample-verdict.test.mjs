// Should this file be re-encoded at all?
//
// Answered from graded samples, before an hour of work rather than after. The
// cases below are the real numbers from one night's run, when twenty-one films
// were re-encoded for hours and then thrown away by the quality gate — every
// one of them a film-stock transfer whose grain is the thing being destroyed.
//
// Two ways to get this wrong, and they are not symmetric. Passing a film that
// should have been refused wastes an hour. REFUSING a film that would have
// passed loses the saving for good, because a skipped file is not retried. So
// the margin exists to make near-misses go ahead, and these tests pin both
// edges of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleVerdict, SAMPLE_MARGIN, VMAF } from '../vmaf.mjs';

const probe = (mean, min = mean) => ({ vmafMean: mean, vmafMin: min, kbps: 4500, saveBytes: 9e9 });

// The films that actually got wrecked-then-rejected, by their measured scores.
test('the grainy catalogue titles are refused before the encode starts', () => {
  for (const [name, score] of [
    ['Doctor Strange in the Multiverse of Madness', 68.6],
    ['Unhinged', 66.1],
    ['Boba Fett Book II', 68.4],
    ['Knock at the Cabin', 70.1],
    ['Uncharted', 71.6],
    ['Zootopia 2', 79.7],
    ['The Holdovers', 79.9],
    ['Raiders of the Lost Ark', 84.8],
    ['In the Mood for Love', 87.8],
    ['Belfast', 88.7]
  ]) {
    const v = sampleVerdict(probe(score));
    assert.ok(v, `${name} scored ${score} and must be refused`);
    assert.match(v, /left alone|leaves? it alone|is left alone/i);
  }
});

// The other side: films that scored just under the mark would still have been
// worth trying, because a clip scores lower than the same seconds inside a full
// encode. Refusing these would lose real savings permanently.
test('a narrow miss still goes ahead — the sample is not the final word', () => {
  for (const score of [94.8, 94.6, 94.3, 94.0, 92.5, VMAF.min - SAMPLE_MARGIN]) {
    assert.equal(sampleVerdict(probe(score)), null, `${score} is a near miss and must not be refused`);
  }
});

test('anything comfortably over the mark goes ahead', () => {
  for (const score of [95, 96.1, 99.4]) assert.equal(sampleVerdict(probe(score)), null);
});

// The floor catches a film that averages well but falls apart in one scene —
// the Crystal Skull case, mean 95.2 but a worst window of 86.1.
test('a collapsing scene is caught even when the average looks fine', () => {
  const v = sampleVerdict(probe(95.2, 60));
  assert.ok(v, 'a scene at 60 must stop the job whatever the mean says');
  assert.match(v, /worst sampled scene/);
});

test('a worst scene only slightly under the floor still goes ahead', () => {
  // CODA: mean 95.6, worst window 89.8. Two tenths under the floor is exactly
  // the kind of near-miss the margin exists for — let the real gate decide.
  assert.equal(sampleVerdict(probe(95.6, 89.8)), null);
});

// Crystal Skull: mean 95.2, worst window 86.1. The average looks healthy and
// the real gate still refused it, which is the case for catching it early —
// nearly four points under the floor is not a near-miss.
test('a scene well under the floor is refused despite a healthy average', () => {
  const v = sampleVerdict(probe(95.2, 86.1));
  assert.ok(v, 'the mean must not be able to hide a collapsing scene');
  assert.match(v, /86\.1/);
});

// Never refuse on evidence that does not exist. An ungraded probe means the
// grading was unavailable, not that the file is bad, and treating it as a
// refusal would silently stop the optimizer doing any video work at all.
test('an ungraded probe is not evidence and never refuses', () => {
  assert.equal(sampleVerdict({ kbps: 4500, saveBytes: 9e9 }), null);
  assert.equal(sampleVerdict({ vmafMean: null, vmafMin: null }), null);
  assert.equal(sampleVerdict(null), null);
  assert.equal(sampleVerdict(undefined), null);
});

// The message is the whole explanation the owner ever gets for a film that was
// left alone, so it has to say why rather than just refusing.
test('the refusal explains itself in terms of the picture', () => {
  const v = sampleVerdict(probe(68.6));
  assert.match(v, /68\.6/, 'says what it measured');
  assert.match(v, new RegExp(String(VMAF.min)), 'says what it needed');
  assert.match(v, /grain|detail/i, 'says what it thinks is being destroyed');
});

test('the margin is a real allowance, not zero', () => {
  assert.ok(SAMPLE_MARGIN > 0);
  assert.equal(sampleVerdict(probe(VMAF.min - SAMPLE_MARGIN + 0.1)), null, 'inside the margin: go');
  assert.ok(sampleVerdict(probe(VMAF.min - SAMPLE_MARGIN - 0.1)), 'outside the margin: stop');
});
