import { demoData } from '../test/fixture';
import { UNSET_PROBLEM_COLOR } from '../lib/board';

/** A wide, long-name contest for checking scroll regions and sticky identities. */
export function wideData() {
    const data = demoData();
    data.contest.contest_name = 'Hydro 程序设计竞赛 · 多题目与长名称适配演示';
    data.contest.problem_quantity = 15;
    data.contest.problem_id = Array.from({ length: 15 }, (_, index) => String.fromCharCode(65 + index));
    // Only A–C have a balloon colour, as in a contest where Hydro's colours are partly set.
    const colors = data.contest.balloon_color as { color: string, background_color: string }[];
    while (colors.length < 15) colors.push({ color: '#000', background_color: UNSET_PROBLEM_COLOR });
    for (let id = 9; id <= 64; id++) {
        data.teams.push({ team_id: String(id), name: `程序设计竞赛代表队 ${id} 号选手`, organization: `第 ${id % 8 + 1} 高校计算机与软件工程学院（程序设计竞赛训练中心）`, group: [id % 4 ? 'official' : 'unofficial'] });
    }
    for (const team of data.teams) {
        for (let problem = 3; problem < 15; problem++) {
            if ((Number(team.team_id) + problem) % 3 === 0) continue;
            data.submissions.push({ submission_id: `wide-${team.team_id}-${problem}`, team_id: team.team_id, problem_id: problem,
                timestamp: (problem * 600 + Number(team.team_id) * 30) * 1000,
                status: (Number(team.team_id) + problem) % 7 === 0 ? 'FROZEN' : (Number(team.team_id) + problem) % 5 === 0 ? 'INCORRECT' : 'CORRECT' });
        }
    }
    return data;
}

/** A Hydro 5.1 team contest: the demo teams get team names and three members each. */
export function teamData() {
    const data = demoData();
    data.contest.contest_name = 'Hydro 组队赛 · 队员信息演示';
    const names = ['星火队', '破晓队', '启明队', '远航队', '晨曦队', '长风队', '青云队', '北辰队'];
    const people = ['林澈', '周宁', '陈言', '苏禾', '许青', '江屿', '沈星', '陆川', '顾遥', '叶舟', '温岚', '宋知'];
    data.teams = data.teams.map((team, index) => ({
        ...team, name: names[index % names.length],
        ...(index === 1 || index === 3 ? { girl: true } : {}),
        coaches: [index % 2 ? '吴老师' : '陈老师'], location: `A-${String(index + 1).padStart(2, '0')}`,
        members: [0, 1, 2].map((offset) => people[(index * 3 + offset) % people.length]),
    }));
    return data;
}
