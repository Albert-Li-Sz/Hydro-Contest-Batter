const key = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();

/** Ambiguous filenames must be assigned manually. */
export function matchPhoto(filename, teams) {
    const stem = key(filename).replace(/\.[^.]+$/, '');
    if (!stem) return null;
    const matches = teams.filter(team => [team.uid, team.account, team.name].some(value => key(value) === stem));
    return matches.length === 1 ? matches[0].uid : null;
}
