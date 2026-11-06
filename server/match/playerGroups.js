/** Seeded random groups with a fixed maximum size. Small tails are balanced against the preceding group. */
export function randomPlayerGroups(players, maxSize, rng) {
  const people = rng.shuffle(Array.isArray(players) ? players.slice() : []);
  const size = Math.max(1, Math.floor(Number(maxSize) || 1));
  const groups = [];
  let offset = 0;
  while (offset < people.length) { // loop-cap: at most players.length groups
    const remaining = people.length - offset;
    let take = Math.min(size, remaining);
    // For the four-player draft, a 4+1 or 4+2 tail leaves a much smaller independent group.
    // Rebalance those last 5–6 players as 3+2 / 3+3 while keeping earlier full groups intact.
    // Smaller max sizes (such as the custom 联防 helper pairs) keep their existing partitioning.
    if (size === 4 && remaining > size && remaining <= size + 2) take = Math.ceil(remaining / 2);
    groups.push(people.slice(offset, offset + take));
    offset += take;
  }
  return groups;
}
