// Matching extracted bits against the registry of issued watermark messages.

const logFactCache = [0];
function logFact(n) {
  for (let i = logFactCache.length; i <= n; i++) logFactCache[i] = logFactCache[i - 1] + Math.log(i);
  return logFactCache[n];
}

// log10 of P(X >= k) for X ~ Binomial(n, 0.5): the chance that a random,
// unwatermarked image agrees with a given message on at least k bits.
export function log10TailP(n, k) {
  const terms = [];
  for (let i = k; i <= n; i++) terms.push(logFact(n) - logFact(i) - logFact(n - i) - n * Math.LN2);
  if (terms.length === 0) return -Infinity;
  const max = Math.max(...terms);
  const sum = terms.reduce((s, t) => s + Math.exp(t - max), 0);
  return (max + Math.log(sum)) / Math.LN10;
}

export function hammingAgree(a, b) {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same;
}

// Thresholds on the false-positive probability after correcting for the
// number of comparisons (registry size x image variants tried).
export const STRONG_LOG10 = -6; // fewer than 1 in a million chance of a false match
export const WEAK_LOG10 = -3;

export function matchAgainstRegistry(candidates, videos) {
  const nbits = candidates[0]?.bits.length ?? 256;
  const comparisons = Math.max(1, candidates.length * videos.length);
  let best = null;
  const perCandidate = candidates.map((c) => {
    let cBest = null;
    for (const v of videos) {
      const agree = hammingAgree(c.bits, v.bits);
      if (!cBest || agree > cBest.agree) cBest = { agree, video: v };
    }
    const res = { ...c, bestAgree: cBest?.agree ?? null, bestVideoId: cBest?.video.id ?? null };
    if (cBest && (!best || cBest.agree > best.agree)) best = { ...cBest, variant: c.variant, box: c.box };
    return res;
  });

  if (!best) return { verdict: "none", reason: "No watermarked videos are registered yet.", candidates: perCandidate.map(({ bits, ...rest }) => rest) };

  const log10p = log10TailP(nbits, best.agree);
  const log10pCorrected = Math.min(0, log10p + Math.log10(comparisons));
  const verdict = log10pCorrected <= STRONG_LOG10 ? "match" : log10pCorrected <= WEAK_LOG10 ? "weak" : "none";
  return {
    verdict,
    bitAccuracy: best.agree / nbits,
    matchedBits: best.agree,
    nbits,
    log10FalsePositive: log10pCorrected,
    variant: best.variant,
    box: best.box,
    video: verdict === "none" ? null : publicVideo(best.video),
    closestVideoId: best.video.id,
    comparisons,
    candidates: perCandidate.map(({ bits, ...rest }) => rest),
  };
}

export function publicVideo(v) {
  const { bits, ...rest } = v;
  return rest;
}
