// 选手视角: pick a team, then Hydro's contest pages open as that team sees them (lib/perspective.ts).
const { teams } = JSON.parse(document.getElementById('perspective-runtime').textContent);
const list = document.getElementById('perspective-teams');
const search = document.getElementById('perspective-search');
const key = (value) => String(value ?? '').normalize('NFKC').toLowerCase();
const rows = teams.map((team) => {
    const button = document.createElement('button');
    button.type = 'submit'; button.name = 'uid'; button.value = String(team.uid); button.className = 'resolver-session';
    const name = document.createElement('strong'); name.textContent = team.name;
    const school = document.createElement('small'); school.textContent = team.school;
    const info = document.createElement('span'); info.className = 'resolver-session-info'; info.append(name, school);
    button.append(info);
    return { button, text: key(team.name + ' ' + team.school + ' ' + team.uid) };
});
list.append(...rows.map((row) => row.button));
search.addEventListener('input', () => {
    const query = key(search.value).trim();
    for (const row of rows) row.button.hidden = !!query && !row.text.includes(query);
});
search.focus();
