"""Complete-linkage clustering for grouping files by pairwise similarity -
used by duplicates.py (near-duplicate documents, by text similarity).
Originally written for the (since removed) Smart albums feature, which
clustered CLIP image embeddings with it.

Why complete-linkage and not the simpler "link anything above the
threshold, then take connected components" (plain union-find, which is
what duplicates.py's near-duplicate *image* detection still uses, at a very
strict 0.97 threshold where chaining is rare): at a looser threshold,
union-find is prone to chaining unrelated items together through a middle
item that happens to sit in a "busy"/generic region of the similarity space
- confirmed empirically for images (found while building the since-removed Smart albums) and
again for documents (same symptom: a handful of items with generic,
widely-shared content chained a large, otherwise-unrelated set together
into one dominant blob). Complete-linkage resists that: two groups only
merge when EVERY cross-pair between them clears the bar, not just one link
in a chain.
"""
from __future__ import annotations

from typing import List


def complete_linkage_cluster(sims, threshold: float) -> List[List[int]]:
    """Complete-linkage agglomerative clustering: repeatedly merges whichever
    two groups have the highest COMPLETE-linkage similarity (the worst,
    i.e. smallest, similarity between any member of one and any member of
    the other) as long as that's still above threshold, stopping the
    instant it isn't. Takes an already-computed, symmetric similarity
    matrix directly (sims[i, j], a numpy array) - nothing here is specific
    to what that similarity actually measures (CLIP cosine similarity,
    weighted word-Jaccard, anything else in [≈0, 1] with higher meaning
    "more alike")."""
    import numpy as np

    n = sims.shape[0]
    sim = sims.copy()
    np.fill_diagonal(sim, -np.inf)
    members = {i: [i] for i in range(n)}
    active = list(range(n))

    while len(active) > 1:
        sub = sim[np.ix_(active, active)]
        ia, ib = np.unravel_index(np.argmax(sub), sub.shape)
        best = sub[ia, ib]
        if best < threshold:
            break
        a, b = active[ia], active[ib]
        # Lance-Williams update for complete linkage: the merged group's
        # similarity to anything else is the WORSE (lower) of the two
        # groups' similarities to it - a merge can only ever make the
        # group's similarity to the rest of the world go down, never up,
        # which is exactly what keeps a loose outlier from dragging two
        # otherwise-separate groups together.
        for k in active:
            if k == a or k == b:
                continue
            newv = min(sim[a, k], sim[b, k])
            sim[a, k] = newv
            sim[k, a] = newv
        members[a] = members[a] + members[b]
        active.remove(b)
        sim[b, :] = -np.inf
        sim[:, b] = -np.inf

    return [members[i] for i in active]
