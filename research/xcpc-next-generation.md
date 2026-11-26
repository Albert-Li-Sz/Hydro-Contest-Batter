# XCPC 办赛需求与 Hydro Contest Better 下一代更新方向

调研日期 2026-11-25，插件基线 **v1.23.2**。资料取自 ICPC 总部、ICPC Asia EC（北京大学）、CCPC 组委会、DOMjudge、ICPC Tools 与 CCS 规范、Hydro 赛事技术团队六个站点，以 2026–27 赛季的现行文件为准。上一轮中国 XCPC 办赛流程调研（基线 v1.19.1）提出的 13 项里，学校名次与奖杯、封榜联动、重测复核和录像已在 v1.20–v1.23 落地，本文只在必要处引用它。

本轮交付 A 奖项规则、C 诚信复核、G 裁判操作、J 证书及 J2 颁奖台本。下文对既有功能和缺口的描述以 v1.23.2 为基线。v1.24.0 的实现和验收口径列在第五节。

1. CCPC 全国赛按有提交的正式队累计取整。香港站样例按过题正式队分档取整，西安邀请赛以金牌数计算银、铜名额。相同队伍和成绩可以得到三套不同的奖牌线，因此所有输出须沿用同一份规则。[CCPC 基本规则][ccpc-basic] · [西安邀请赛指南][xian]
2. Asia EC 网络赛给查重和录像复核留出 168 小时。裁判需要把相似源码、提交时刻和相应的屏幕或摄像头录像对在一起，再记录结论及依据。[EC 网络赛手册][ec-online-handbook] · [Asia EC 承办办法][ec-host]
3. 证书要同时处理奖项、姓名、学校和教练。CCPC 按赛季发布整包证书，世界总决赛也给个人和教练发证。本轮从选定的成绩快照制证，并用滚榜会话保存的获奖名单编排台本。[CCPC 证书栏目][ccpc-cert] · [WF 规则][wf-rules]

## 一、2026–27 赛季的流程

| 阶段 | ICPC（总部与 Asia EC） | CCPC | 本轮对应 |
| --- | --- | --- | --- |
| 注册与资格 | 教练和三名队员须在参加**任何**资格赛之前在 ICPC 注册系统完成注册，不能事后补登。区域赛最迟赛前 7 天注册，RCD 接受后才有参赛资格。资格条件：2022 年及以后入学或 2003 年及以后出生。Asia EC 另有规定：同队同校，一个赛季只代表一所学校，入学五个学年以内，每季最多参加 2 场区域赛（EC Final 除外），拒绝参加统一的拍照、录像或直播活动会被取消资格。[区域赛规则][icpc-regional] · [承办办法第二十八条][ec-host] | 每队 3 名在籍本科或专科生加 1 名在职教练。每人每学年最多参加 2 场全国赛，女生赛和高职赛不计。[基本规则第 2 节][ccpc-basic] | 不做（赛季台账、名单导入） |
| 网络预选 | 两场，2026-09-06 和 09-12 的 13:00–18:00，PTA 加 OMS 双机位监考。[EC 网络赛手册][ec-online-handbook] | 2026-09-19 13:00–18:00，PTA OMS V2.1.3，不安排热身赛。[CCPC 网络赛手册][ccpc-online-handbook] | 不做（线上赛模式）。查重和录屏复核由 C 覆盖 |
| 名额与赛站 | 各站名额先后公布。2026 赛历：西安 10-17、成都 10-24、武汉 10-31、南京 11-07、沈阳 11-14、上海 12-05、南昌 12-19、香港 2027-01-09、杭州 EC Final 2027-01-26 至 28。[Asia EC 赛事汇总][ec-schedule] | 每场全国赛 240–300 支正式队。学校之间可以交换名额，放弃的名额转为外卡，打星名额须向组委会报备。[基本规则第 5 节][ccpc-basic] | 不做 |
| 正式赛 | 5 小时，至少 6 题。语言至少包括 Java、Kotlin、Python3、C 和 C++。最后一小时通常暂停公布通过结果，被拒的结果照常通知本队。[区域赛规则][icpc-regional] | 5 小时，不少于 11 题，至少支持 C、C++ 和 Java。封榜一小时内不升气球。[基本规则第 3 节][ccpc-basic] | 已支持。现场裁判操作由 G 补齐 |
| 赛后 | 成绩公开后，教练须在 1 个工作日内投诉。RCD 2 个工作日内答复，教练再有 1 个工作日上诉，申诉委员会 2 个工作日内裁决。流程走完前成绩不算终版，单次提交的判定不能申诉。[区域赛规则][icpc-regional] EC 网络赛完成查重和录屏检查后（168 小时内）才发布成绩，申诉须实名，由领队和 3 名队员签字并加盖学校公章。[EC 网络赛手册][ec-online-handbook] | 纪律申诉在 3 个工作日内书面提出（见上一轮调研）。证书按赛季打包发布。[CCPC 证书栏目][ccpc-cert] | C 诚信复核、J 证书、J2 颁奖台本 |
| 晋级 | 中国赛区的世界总决赛名额 N = A + B + C + D：各赛站名额、EC Final 名额、承办校优惠和港澳名额。[承办办法第二十七条][ec-host] | 总决赛名额分给学校，女队名额只能派女队，专科名额只能派专科队。[基本规则第 7 节][ccpc-basic] | 不做 |
| 世界总决赛 | 2026 届于 2027-04-04 至 09 在迪拜举行，2027 届预计改到 2027 年 9 月。[WF 规则][wf-rules] · [区域赛规则][icpc-regional] | 总决赛在每学年 3–6 月举行 | A 的 WF 奖项、J 的个人证书 |

本赛季规模：60,948 名学生、35,480 支队伍、3,148 所院校、251 场比赛、1,312 个赛点。[WF 规则][wf-rules]

## 二、同一份成绩，各处的奖法不同

| 比赛 | 名额规则 | 插件 v1.23.2 |
| --- | --- | --- |
| CCPC 全国赛 | 分母 A 为至少提交一次的正式队。金 = ⌈10%·A⌉，银 = ⌈30%·A⌉ − 金，铜 = ⌈60%·A⌉ − 银 − 金。[附 1][ccpc-basic] | 分母只能是过题正式队，各档单独向上取整。31 队样例中 4 支零过题时，插件算出 3/6/9，规则应为 4/6/9 |
| CCPC 总决赛 | 学校名次 1–10 金、11–30 银、31–60 铜。60 名以后且至少解出一题的发优胜奖，另设最佳专科队伍奖。[第 8 节][ccpc-basic] | 已支持按学校名次发奖牌。优胜奖和最佳专科队伍奖需要条件奖 |
| ICPC 区域赛（以香港站为例） | 至少解出一题的有效队，金银铜各档分别向上取整 | 已支持 |
| ICPC 西安邀请赛 | 金 = ⌈10%·总队数⌉，银为金的 2 倍，铜为金的 3 倍 | 不支持 |
| 第 50 届世界总决赛 | 金、银、铜为第 1–4、5–10、11–20 名。第 1–25 名均获 Highest Honors，颁奖流程单列第 21–25 名上台。第 26–50 名获 High Honors，第 51–100 名获 Honors。前 25 名的 place 等于 rank。其余队伍在前 25 名以外按过题数分组，组内共享最高 rank 作为 place。另有 Division 冠军、First Solution Award 和各题 First To Solve。[WF 规则][wf-rules] | 固定数量可以设成 4/6/10。Honors 分档、place 并列和全场首个解题奖都没有 |

v1.23.2 的条件奖缺口如下。

| 奖项 | 规则 | v1.23.2 |
| --- | --- | --- |
| 最快解题奖 | 每题最快通过的队伍，含打星队 | 已支持，按榜设置打星资格 |
| 最佳女队 | 女队（含打星）至少 3 支才设奖。取排名最高的女队，但不能低于铜奖末位 | 不支持数量门槛和成绩线 |
| 顽强拼搏奖 | 在未获金银铜的队伍（含打星）中，取最晚解出题目的 1 或 2 队 | “最后一个通过”排除了打星队，也不排除已获奖牌的队伍 |
| WF First Solution Award | 全场第一个解出任意一题的队伍 | 只有分题一血 |

**ICPC 的现行规则比 CCS 规范变得快。** CCS 系统需求文档仍以 “12+B” 描述奖牌和排名，WF 规则已改为 4-6-10 加 Honors，Contest API 2026-01 也已新增 honors、high-honors 和 highest-honors 三类奖项 ID。规则应该配置化，不要按某一年写死。[CCS 系统需求][ccs-req] · [Contest API 2026-01 变更][ccs-2026]

## 三、需求与痛点

### 1. 禁用 AI 之后，诚信判定靠人工复核（C）

- **规则已经全面禁止。** EC 网络赛禁止任何 AI 相关功能及插件，包括本地大模型。巡查或赛后录屏中只要发现装了 AI 插件，无论是否使用都按作弊处理。[EC 网络赛手册][ec-online-handbook] CCPC 网络赛禁止“达到或超出编程初学者水平的辅助功能”，包括大语言模型和非词典类的智能补全，同时禁止虚拟机、双屏、蓝牙耳机和触碰 USB 接口。[CCPC 网络赛手册][ccpc-online-handbook] 世界总决赛关闭所有 IDE 的内置 AI，摄像头全程录制画面和声音。[WF 编程环境][wf-env] Hydro Contest OS 同样关闭了 AI 功能，计划在 2026 年部分 EC 区域赛使用。[Hydro Contest OS][hydro-os]
- **处罚连坐，证据必须站得住。** 网络赛作弊会取消该校当场所有队伍的成绩，作弊队员 3 年内禁赛。[承办办法第二十九条][ec-host] EC 规定 168 小时内完成查重和录屏检查后才发布成绩。手册还提醒选手，手机上的所有操作都要在第一机位前完成，以免被误判。[EC 网络赛手册][ec-online-handbook]
- **插件已有的基础。** 选手屏幕和摄像头的 WebRTC 采集、双路全程留档（720p24）、提交前后的片段、自检与全场压力测试，以及能读取全部比赛代码的权限。
- **v1.23.2 的缺口。** 没有代码相似度分析，没有把提交、录像、采集中断和窗口切换排在同一条时间轴上的复核视图，没有复核分工、时限和结论记录，也没有作为证据导出的功能。

### 2. 现场运维需要更多裁判操作（G）

CCS 系统需求列出了以下管理功能：移除一段比赛时间（可撤销）、修改比赛时长、调整单队罚时、忽略某次提交、暂停单题评测、带预览和筛选的重测、人工改判须重新认证并记日志。[CCS 系统需求][ccs-req] DOMjudge 支持先生成重测、审阅后整体应用或取消，以及判定须经裁判确认才生效（`verification_required`）。提问支持预设答复、分类队列和 Markdown 加 LaTeX。封榜后可以只给已获气球少于设定数量的队伍送气球。[DOMjudge 评测][dj-judging] · [DOMjudge 运行][dj-running]

插件依赖 Hydro 的重测，结果会立即生效，只能事后复核和恢复。

### 3. 颁奖与证书（J、J2）

- **谁拿什么证书由规则决定。** CCPC 全国赛的金银铜“颁发奖牌和获奖证书”，打星队不获得金银铜的奖牌或证书，但可以拿含打星的最快解题奖和顽强拼搏奖。总决赛 60 名以后且至少解出一题的发优胜奖证书，最佳专科队伍发奖牌和证书。[基本规则第 5、6、8 节][ccpc-basic] 世界总决赛除团队奖外，给每名队员发 Finalist 个人证书、每名教练发 Coach 证书，颁奖后发到个人的 ICPC 账户。[WF 规则][wf-rules]
- **现在的发放方式。** CCPC 官网“证书”栏目按赛季发布，每期一个全场电子证书压缩包（如“CCPC2025-总决赛-电子证书.7z”），证书版式为中英双语的“获奖证书 Certificate of Achievement”。官网栏目提供整包下载，本次调研未确认是否另有按姓名或编号核验的入口。[CCPC 证书栏目][ccpc-cert] · [CCPC 2025 总决赛证书][ccpc-cert-2025final]
- **制证要核对的字段比成绩表多。** 中英文姓名、英文校名、教练、组别，以及奖杯和特别奖的重叠，晚到的更正也要能单独补发（上一轮第 13 项）。西安邀请赛要求报名时同时填中英文信息。[西安邀请赛指南][xian]
- **v1.23.2 的功能。** 获奖名单 CSV 按奖项列出队伍、学校、队员和教练（教练来自 onsite-toolkit 导入的 `coach` 字段）。没有英文姓名和英文校名，没有证书模板、编号和核验页。滚榜能展示特别奖，但没有候场名单和主持台本。

## 四、本轮不做的方向

以下方向的调研依据保留在此，供以后重新评估。

| 方向 | 依据 |
| --- | --- |
| B 成绩状态、申诉与颁奖版 | 赛事申诉时限作为赛务背景保留。暂定、申诉、终版及统一颁奖版不在本轮范围内。[区域赛规则][icpc-regional] |
| F 外部 CCS 接入与影子比对 | 本轮只涉及插件已有的对外 Contest API 在奖项、暂缓公布和补时上的一致性。读取外部 CCS、影子重评及系统间差异对账均已移出范围。[DOMjudge 影子模式][dj-shadow] |
| D 线上赛与混合赛模式 | 两份网络赛手册的流程几乎相同：每名队员一台电脑，只有队长机能提交，用手机做第二机位，开赛后查验学生证，离场在微信群报备，题面修改用弹窗通知，停电断网不补时。目前由 OMS 客户端、小程序和 QQ 或微信群完成。[EC 网络赛手册][ec-online-handbook] · [CCPC 网络赛手册][ccpc-online-handbook] |
| E ICPC 数据交换 | 承办方须在 ICPC 官网上传成绩，系统须满足官网的数据提交要求。[承办办法第二十一、二十四条][ec-host] Contest Package 规定了报名上传与成绩上传的文件。[Contest Package][contest-package] DOMjudge 文档写明从 ICPC CMS API 导入已失效。[DOMjudge 导入][dj-import] |
| H 赛季台账 | Asia EC 每人每季最多 2 场区域赛，世界总决赛名额按 A + B + C + D 分配，承办校优惠按 10/18 名、边远地区按 15/23 名设线。[承办办法第二十七、二十八条][ec-host] |
| I 验题流水线 | ICPC 题目包格式 2025-09 用 `submissions.yaml` 标注标程和错解的期望结果，DOMjudge 10 正在支持。[DOMjudge ChangeLog][dj-changelog] |
| K 机房环境接入 | WF 环境为 Ubuntu 24.04、gcc 13.2、OpenJDK 21、PyPy3 和 Kotlin 1.9.24。Hydro Contest OS 为 Ubuntu 24.04.5 加 GCC 14.2。xcpc-tools 能采集选手机器状态。[WF 编程环境][wf-env] · [Hydro Contest OS][hydro-os] · [xcpc-tools][xcpc-tools] |
| L 规模与可靠性 | CCS 需求要求数据丢失不超过 1 分钟、榜单延迟不超过 30 秒、至少 200 队 15 题。CCPC 全国赛为 240–300 支正式队。联合承办须共享一张榜单。[CCS 系统需求][ccs-req] · [承办办法第十一条][ec-host] |
| M 许可替换 | ICPC Tools 的许可禁止商业使用，可被撤销，并要求公开源码。Team View 例外，采用 MIT 许可。插件的 Resolver 包含 ICPC Tools 内容。[ICPC Tools][icpc-tools] |

## 五、本轮交付与验收口径

| 方向 | v1.24.0 交付 | 验收方法 |
| --- | --- | --- |
| A 奖项规则 | 五种模板可写入比赛配置。按所选分母、取整方法或金牌倍数计算奖牌，支持 WF Honors、分队数和成绩线的条件奖。 | 用 31 支正式队分别套用 CCPC 全国赛、区域赛、金牌倍数和 WF 模板，核对各档名额与获奖队伍。另用有零过题队、打星队、并列队及女队数量临界点的样例覆盖规则边界。 |
| C 诚信复核 | 按题比较提交，列出相似队伍并显示学校。裁判可并排读源码，从队伍时间轴查提交、录像覆盖、中断和多屏信号，分派任务、记录结论并导出证据。 | 从相似对建立复核，核对负责人和默认 168 小时的期限。认定违规会拍下当时的成绩快照，处分由裁判另行执行。导出的证据应能对应到该队、该题和两份源码。 |
| G 裁判操作 | 按题和比赛时间暂缓公布，支持重测前暂缓、按队补时和经密码确认的人工改判。保留原因、操作者、改判前快照；气球支持封榜后的鼓励名额，答疑台增加统一答复。 | 对照同一次提交在公开榜、裁判视图与对外 CCS 的判定和相对时间，恢复公布或撤销补时后再次核对。检查重测、气球及操作记录。 |
| J 证书 | 选择已结算的成绩快照和榜单，校对或导入中英文制证信息，锁表后出证。支持队伍、队员、教练、参赛证明，模板背景为 PNG 或 JPEG。可按校打包或下载合并 PDF，选手可从比赛页领取。 | 核对样张、页数、学校目录、领取权限和公开核验信息。单队更正后核对旧号、新号与其他队伍保留的编号。 |
| J2 颁奖台本 | 从一个已生成的滚榜会话编排候场、上台和特别奖，支持打印。台本标明彩排状态。 | 对照同一会话的揭晓次序、获奖队伍与特别奖。成绩变更后，重新创建会话。 |

赛务人员可在颁奖前将制证快照与滚榜会话选在同一榜单、同一成绩时点。具体操作见[使用手册](../docs/usage.md)，实测的样例、运行环境和设备边界见[验收记录](../docs/verification.md)。

v1.24.1 为 J 证书增加横向和纵向竞赛版式。主办方可为一场比赛选择或上传最多两枚校徽，获奖证书和参赛证明共用。调整校徽或版式后，重新下载的 PDF 沿用已签发的证书编号。[三页排版样张](../docs/examples/certificates.pdf)

v1.25.0 的制证信息表支持按中文校名匹配英文校名、为队员和教练生成拼音。证书编辑器提供五套可切换横竖方向的样式，支持拖动和缩放上传的装饰图片。[五套证书的横竖版样张](../docs/examples/certificate-styles.pdf)

v1.26.0 新增中英文赛事模板。主办方可分别替换左、中、右三处签名，设置署名和职务的文字颜色，并在中文模板中切换赛事左侧标识。[中文赛事样张](../docs/examples/certificate-event-zh.pdf) · [英文赛事样张](../docs/examples/certificate-event.pdf)

## 资料缺口

- Asia EC 各站名额通知和邀请函的正文是图片或附件，未能读取。
- CCPC 2026 网络赛报名通知是扫描件，未读取。CCPC 官网的“查询”页没有加载出内容，未确认能否按姓名或编号核验证书。证书压缩包未下载，证书的具体字段以官网栏目封面为准。
- Hydro 文档站（docs.hydro.ac）返回空页面，hydro.ac 返回 403。Hydro 原生比赛功能以本仓库代码为准。
- CCS 系统需求和 Contest API 页面的后半部分是摘要阅读，其中“12+B”和状态字段的顺序等细节在开发前应对照原文再核一次。

[icpc-regional]: https://icpc.global/regionals/rules
[wf-rules]: https://icpc.global/worldfinals/rules
[wf-env]: https://icpc.global/worldfinals/programming-environment
[ec-host]: https://icpc.pku.edu.cn/docs/2026-02/bc190c019f4649d5aeea1dd105bb795f.pdf
[ec-online-handbook]: https://icpc.pku.edu.cn/docs/2026-08/77ea6405152140158e9730cac73e04ed.pdf
[ec-schedule]: https://icpc.pku.edu.cn/ssxx/bed2c89264fd4d90b08bc93036051186.htm
[ccpc-basic]: https://ccpc.io/rules/376
[ccpc-online-handbook]: https://ccpc.io/post/388
[ccpc-cert]: https://ccpc.io/cert
[ccpc-cert-2025final]: https://ccpc.io/post/385
[xian]: https://icpc.pku.edu.cn/docs/2026-03/b165028b876f4a99a5d5f961478bd21c.pdf
[dj-shadow]: https://www.domjudge.org/docs/manual/main/shadow.html
[dj-judging]: https://www.domjudge.org/docs/manual/main/judging.html
[dj-running]: https://www.domjudge.org/docs/manual/main/running.html
[dj-import]: https://www.domjudge.org/docs/manual/main/import.html
[dj-changelog]: https://www.domjudge.org/snapshot/ChangeLog
[icpc-tools]: https://tools.icpc.global/
[icpc-cds]: https://tools.icpc.global/cds
[ccs-2026]: https://ccs-specs.icpc.io/2026-01/
[ccs-req]: https://ccs-specs.icpc.io/2026-01/ccs_system_requirements
[contest-package]: https://ccs-specs.icpc.io/2026-01/contest_package
[hydro-contest]: https://contest.hydro.ac/en/
[hydro-team]: https://contest.hydro.ac/en/team/
[hydro-os]: https://contest.hydro.ac/en/contest-os/
[xcpc-tools]: https://github.com/hydro-dev/xcpc-tools
