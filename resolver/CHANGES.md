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
