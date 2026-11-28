# Resolver-Web v1.4.0 移植修改记录

固定 commit 为 `d4a1a80fa1c0a7b0013f941256004ba5f63c6773`。（v1.4.0 是附注标签，标签对象为 `1d9788e1430c4898e463d99f52aab6c400399328`，早期记录曾把它误写为 commit。）`UPSTREAM.json` 中 `sha256` 为该 commit 的源文件哈希，`modifiedSha256` 为本包文件哈希。记录的许可证、字体与图片保持原始字节。

- `server/lib/engine.js` 统一使用 Hydro 封榜判断，并允许插件本地 Logo 路径通过资源校验。
- `public/js/freeze.js` 保留封榜点当秒可见，封榜之后包括不计罚时结果也隐藏。Hydro 数据缺少封榜点时报错，彩排沿用上游忽略未评测提交行为。
- `public/js/medals.js` 正式且有过题的选手参与金银铜与前三名。一血资格由所选榜单的共享设置决定。
- `public/js/play.js` 使用 Hydro 独立会话接口与控制令牌，保存步骤采用版本条件更新，冲突、断线暂停并恢复数据库进度。移除观众分享操作，修订对应提示，将播放状态 CSS 类和全屏目标限定在 Hydro 播放容器内。
- `templates/xcpcio_resolver_play.html` 源自上游 `public/play.html`，接入 Hydro 的 layout/basic.html，替换资源路径与配置返回链接，嵌入会话信息及彩排提示，使用 Hydro 按钮，移除观众分享控件。
- `public/js/school-logos.js` 使用已打包的本地 Logo 与 ICPC 回退图标。
- `public/js/logos.js`、`public/js/render/resolver-view.js`、`public/js/render/text.js` 替换本地资源前缀。预加载本地 Noto Sans SC，并将其加入既有系统中文字体链末尾。保留原绘图布局、动画和拉丁字体。
- `public/js/display-preferences.js` 按会话路径隔离显示设置。
- `public/js/display-settings.js` 将显示区域几何限制在当前 Hydro 播放容器中，面板使用 Hydro 表单。全屏只作用于播放容器，ResizeObserver 同步容器尺寸。
- 新增 `public/js/hydro-config.js`、`public/hydro-config.css`、`public/hydro-play.css` 与插件配置模板。按用户最新要求，配置和播放均嵌入 Hydro 原生页面，复用 Hydro 表单、按钮、导航和明暗主题。预览复用上游 ResolverView。
- 新增 `lib/resolver-*.ts` 完成 Hydro 原始数据、分榜、权限、配置、MongoDB 分块快照和进度对接。`frontend/resolver*.js` 处理 Hydro 页脚脚本入口、CCS 延迟注入和 PJAX。
- 新增类型声明供插件类型检查使用。`resolver/package.json` 声明上游 ES Module 代码格式。

## 0.7.2 的调整

- `public/js/hydro-config.js` 与配置模板：封榜点改为填写“比赛最后多少分钟”，由页面换算为秒；新增“选手名后显示学校”；显示会话保留天数。
- 适配层：普通分榜滚法跟随比赛的“允许打星选手参与奖项”设置；会话闲置超过保留期后自动删除。
- 构建：`js/` 与样式表发布到 `/hydro-resolver/<插件版本>/`，避免升级后被 Hydro 的静态缓存继续提供旧脚本；图片、字体与校徽路径不变，已保存的会话仍可使用。
- 上游文件本身在这一版没有改动。

主持页可将当前正式或彩排会话绑定到观众大屏。大屏首次加载已揭晓的快照，按会话、版本与步骤位置接收连续前进的增量，回退和进度不一致时重新取得快照。旧版观众端可继续使用原快照协议。

原文件的许可证见包内 `licenses/`，各组件适用范围见根目录 `NOTICE`。原始目录范围包括上游引擎内部的数据解析辅助函数，插件开放的接口仅接受当前比赛与本次滚榜配置。

## 0.7.3 的调整

- 每个榜单独立配置完整奖项规则，榜单与滚榜复用设置。配置页展示共享规则并链接到统一设置入口，预览及创建快照重新读取配置。
- `server/lib/engine.js` 保存一血开关和打星一血资格，统一奖项与单元格高亮，支持同一时间的一血并列。打星身份保持独立，奖牌和前三名只授予正式选手。
- 默认仅主榜，其他榜需显式启用或创建。已有快照继续按创建时保存的数据和步骤播放。
- 默认永久保留会话，自动清理通过最近使用时间条件原子确认删除资格，支持中断重试。
- 同步全部 `modifiedSha256`，回归测试逐条校验来源清单。

- `public/js/standings.js` 使用原始选手名稳定处理同成绩的展示顺序，学校显示开关不影响授奖顺序。增强榜复用同一比较函数。

## 0.7.4 的调整（大屏）

- 新增引入 `public/js/render/` 下其余的 ICPC Tools 展示端移植模块（`presentation-*.js`、`pres-*.js`、`java-*.js`、`digital-font.js`）及 `icpc-balloon*.gif`、`world-map.jpg`。其中 `presentation-view.js`、`pres-floor.js`、`pres-map.js`、`pres-problems.js` 把 `/assets/img/` 改为插件的 `/hydro-resolver/assets/img/`；`presentation-view.js` 的 `render()` 另外改为与 `ResolverView` 一致，只等待拉丁字体，中文字体在后台加载、加载前由系统中文字体显示，避免大屏首次打开时长时间黑屏。其余文件未改动。来源与修改后哈希见 `UPSTREAM.json`。
- 新增 `public/js/hydro-screen.js`（大屏显示页，绘制逻辑沿用上游 `frontend/src/Stage.tsx` 的 `PresentationView.render()` 调用，观众跟随沿用 `public/js/watch.js` 的快照与逐步推进）、`public/js/hydro-screens.js`（大屏管理页）、`public/hydro-screen.css`、`public/hydro-screens.css`。
- 新增 `lib/screens-data.ts`：按上游 `server/platform/model.js` 的 `publicContest()` 与 `presentationStats()` 生成展示数据，数据源换成插件已按封榜规则处理的公开榜；打星选手名次显示为 `*`。`lib/resolver-sessions.ts` 新增按上游 `sessions.js` `snapshot()` 规则生成的只读观众快照。
- 未引入上游的屏幕配对、节目单、PresentationAdmin（React）与 Live 部分。

## 0.7.5 的调整

- 大屏新增判题队列（上游 `queue` 节目项的 `queue` 与 `teams` 两种样式），沿用已引入的渲染模块，未改动其绘制逻辑。

## 0.7.7 的调整

- 大屏展示数据把所选分榜的一血规则（`firstSolveEnabled`、`unofficialFirstSolve`）传给引擎，与榜单高亮一致；首解列表按同一资格筛选。
- 同一会话同一进度的滚榜观众数据只生成一次，供所有大屏共用。上游文件未改动。

## 0.7.8 的调整

- 滚榜观众画面按场馆使用需求不再脱敏，与主持端显示相同的身份。
- `public/js/render/presentation-view.js` 的 `formatClock()` 与 `public/js/render/java-contest.js` 的 `formatTime()` 去掉按 48 小时取余，多日比赛的时钟、倒计时和榜单顶部时间显示完整小时数。新增 `java-contest.d.ts` 类型声明供插件测试使用。

## 0.8.2 的调整（组队比赛）

- `server/lib/engine.js` 的 `normalizeContest()` 保留队伍的 `members`（最多 10 个名字，各不超过 64 个字符），`publicContest()` 随队伍一起输出。
- `public/js/render/resolver-view.js` 的 `_renderTeamAward()` 在队名下方以小号灰字显示队员（仅当队伍有队员时），其余绘制不变。

## 扩展大屏

- 题目统计、题目气球颜色和学校 Logo 墙使用现有 ICPC Tools 画面。`pres-charts.js` 和 `presentation-locale.js` 增加题目统计图的中英文标题、纵轴与图例文字，保留原图形布局。
- `hydro-screen-extras.js` 使用同一套本地字体与 ICPC Tools 配色绘制 Hydro 大屏，数据读取公开榜结果、已配置分榜、onsite-toolkit 座位和比赛公告。


## 同分规则与判题队列的调整

- `public/js/standings.js` 增加 ICPC 区域赛同分规则：Hydro 比赛设置 `tieBreak: 'icpc'` 时，罚时按分钟计（每题通过时间取整到分钟，每次未通过加 20 分钟），相同时最后一题通过时间早者在前，仍相同则并列；新增 `sameStanding()` 判断是否并列。默认仍为 Hydro 规则（罚时精确到秒）。
- `public/js/medals.js` 的并列同奖改用 `sameStanding()`，与名次的并列判断一致。
- `server/lib/engine.js` 的 `normalizeContest()` 与 `publicContest()` 保留 `tieBreak`。
- `public/js/render/presentation-view.js` 的判题队列先画全部行底色，再按动画位置绘制所有可见提交并裁剪到列表区域，修复移动中的提交被下一行底色遮挡、移出列表时盖住表头，以及动画期间末行空缺；离开队列的提交画在其他行下方并逐渐淡出，在场的提交带所在条纹的底色，经过时不再与其他行的文字重叠。`public/js/render/presentation-state.js` 的 `JudgeQueueState` 为离开的提交标记 `leaving` 与起始位置。
- `public/js/render/pres-misc.js` 的 7×3 判题网格把新提交放入下一个空格，修复评测较慢时两条提交叠在同一格。

## CCPC 规则、学校名次与奖杯

- `public/js/standings.js` 增加 CCPC 同分规则（`tieBreak: 'ccpc'`）：罚时按分钟计，与 ICPC 相同；题数和总用时都相同则并列，并列队伍按最晚一次通过时间（秒）先后排列。`scoreTeam()` 输出 `lastSolutionSeconds`。
- 新增 `public/js/trophies.js`：学校名次（CCPC 基本规则 4.2）和奖杯（按队伍或学校名次；并列时最晚通过早者得或共享），榜单、滚榜、Live、CCS 与成绩导出共用。
- `public/js/medals.js` 的奖杯改用 `trophies.js`，支持 `podiumBasis`、`podiumTie`、`podiumNames`；奖牌可按学校名次授予（`medalRanking: 'school'`）。
- `server/lib/engine.js` 的 `normalizeContest()` 保留 `tieBreak: 'ccpc'` 与队伍的 `schoolKey`。

## v1.24.0 奖项与颁奖台本

- `public/js/medals.js` 使用 `honors.js` 的 place 规则生成三档 Honors，与成绩导出和 ICPC Live 共用名次线。
- Hydro 播放模板新增颁奖台本入口。台本从该会话的成绩和奖项生成，保留彩排标记以及同队的特别奖。

## 奖牌行配色

- `public/js/render/shaded-rect.js` 的 `GOLD2`/`GOLD` 由 ICPC Tools 的铜色（205,127,50）改为金色 `#ffd700`。原值叠在 `#3c3c3c` 行底上为 rgb(115,85,56)，与铜牌行 rgb(100,84,60) 几乎无法区分；新值为 rgb(133,118,37)，白字对比度 4.55:1。银、铜行保持上游配色。

## CCPC 新榜单模式的大屏

- `public/js/render/java-contest.js` 的 `getAllSubmissions()` 读取大屏数据中的 `hiddenFrom`：CCPC 封榜前隐藏题号时，从该列起每列是各队自己的位置而不是同一道题，不再为这些列计算一血；`getProblemSummary()` 对这些列返回 0，实时榜单底部与方块榜的各题汇总不再把不同的题合计在一起。判题队列、队伍判题和其他 ICPC Tools 画面因此只在已公开题号的列上显示一血。

## 2.0.0 队伍照片与奖区控制

- `server/lib/engine.js` 接受比赛内的滚榜照片地址。`public/js/render/resolver-view.js` 在选中队伍时预载照片，在获奖画面使用会话里的地址。已在播放的获奖页每 5 秒轻量核对照片凭据，作废后回退到比赛标志。
- `public/js/playback-model.js` 与可打印台本共用奖级顺序，定位各奖区首支队伍的前一个可操作步骤，并提供带时钟参数的双按判定。
- `public/js/play.js` 与 `templates/xcpcio_resolver_play.html` 增加 J、工具栏「下一奖区」及快捷键帮助。再次按 J 直接抵达，Esc 暂停。键盘和右键回退需在 1.5 秒内连按两次。

## 2.1.0 奖区边界、按队跳转与大屏缩放

- `server/lib/engine.js` 在逐行选中和获奖高亮的 `selectTeam` 步骤上记录光标所在行 `row`。
- `public/js/playback-model.js` 按行号定位奖区：取该奖级各队获奖高亮中最低的一行，停在光标第一次到达这一行之前，也就是奖区前一名的边界。没有行号的旧会话沿用 2.0.0 的规则。新增 `teamJump()`，从光标所在行前进或后退 10 行；前进最多停在榜首一行之前。
- `public/js/play.js` 与 `templates/xcpcio_resolver_play.html` 增加 G、I：1.5 秒内双按前进或回退 10 队，前进时快速揭晓（再按 J 直接抵达，Esc 停止），回退立即生效。双按判定按键分别计时。
- `public/js/render/presentation-ports.js` 与 `presentation-view.js` 接收大屏设备的缩放倍数：榜单类画面（带 `teamsPerScreen` 的 ICPC Tools 画面）按倍数减少每屏行数，缓存键包含倍数。其余画布画面不受缩放影响。

## 2.3 的调整

- 滚榜会话记录显示样式和封榜前可见提交的时间、队伍、题目与结果。三维版共用原版的步骤、名次和进度，主持端与观众端均可切换显示样式。
- 冠亚季军名单随最后一步揭示。三维舞台在本地加载 Three.js，WebGL 不可用时回退到原版。

## 2.5 的调整

- `public/js/render3d/` 拆为 `graphics.js`（二维计分板与文字绘制）、`scene.js`（正交机位下的立体道具与背景）和 `resolver-view-3d.js`（揭晓节奏与状态）。计分板始终正面绘制，机位只改变道具角度。
- 揭晓分三段：题牌先翻出判定，再更新过题数与罚时，最后队伍移到新名次。回退或跳转时立即落到目标状态。旧会话没有提交流时，提交回放使用封榜前公开的格子记录。
- `public/js/render/renderer.js` 从三维切回原版时清除画布上的揭晓阶段与无障碍描述。

## 2.6 的调整

- 三维滚榜改为两种 Canvas 2D 样式：`public/js/ccpcoj/gen1.js`（CCPCOJ 一代，白底整屏榜单与获奖对话框）和 `gen2.js`（CCPCOJ 二代，深色开场幕布、双语表头、奖区名次块与全屏获奖页），共用 `draw.js` 的绘图工具和 `resolver-view-ccpcoj.js` 的揭晓节奏：先改变题目格和分数，再按 cubic-bezier(1, 0, 1, 1) 移到新名次，移动时长随距离增加。两种样式只参照 CCPCOJ 的版式，不含其代码或图片。删除 `public/js/render3d/`、Three.js 模块及其许可文件，机位选项随之移除。
- 样式值为 `2d`、`ccpcoj`、`ccpcoj2`。引擎、滚榜配置和大屏设置把 v2.5 的旧值 `3d` 读作 `ccpcoj2`。
- `public/js/render/renderer.js` 不再监听 WebGL 断连。CCPCOJ 样式模块加载或创建失败时回到原版 2D。缩略图上报不再需要先重绘 WebGL 缓冲区。

## 2.6.1 的调整

- `public/js/ccpcoj/gen2.js` 按 CCPCOJ-2 截图重做二代榜单细节：名次、题数、罚时、题号与分钟改用等宽字体；名次块加奖区深色描边，题数罚时改为浅底小格；校徽框在行内垂直居中；题目格按题目数平分整行，宽格把分钟居中；首解金星放大到格子右上角。获奖页的奖章改挂在标题牌下方，奖项牌匾两端加菱形线饰，右栏补充本队各题的解题格。`draw.js` 的 `text()` 增加字体族参数。

## 2.6.2 的调整

- `public/js/ccpcoj/resolver-view-ccpcoj.js` 为每支队伍和榜单滚动分别记录「从当前绘制位置到目标位置」的移动。新步骤只改目标，正在进行的移动接着走完，快速推进、自动滚榜和观众端一次追上多步时不再先跳回旧位置。揭晓阶段（题目格变色与旧分数）与名次移动分开计时。
- `gen1.js`、`gen2.js` 的行高只按每屏行数计算，参赛队伍少于每屏行数时不再拉伸行高。

