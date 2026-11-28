# Hydro Contest Better

[![GitHub Release](https://img.shields.io/github/v/release/Albert-Li-Sz/Hydro-Contest-Better?label=release)](https://github.com/Albert-Li-Sz/Hydro-Contest-Better/releases/latest)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Hydro OJ 的 ACM 办赛插件。工作人员可以在 Hydro 内配置赛制与奖项、运行答疑和气球配送、录制选手机位、向大屏和 OBS 播出比赛。赛后可滚榜、核查诚信并导出成绩。

[快速安装](#快速安装) · [比赛操作手册](https://albert-li-sz.github.io/Hydro-Contest-Better/) · [媒体机安装教程](https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.html) · [版本下载](https://github.com/Albert-Li-Sz/Hydro-Contest-Better/releases/latest)

## 办赛功能

- **赛前准备与交题**　批量粘贴座位/IP，按比赛核对缺失机位，允许选手在指定网段自行登记。管理员可用本机 CSV/TSV 打印 A4 密码条。选手在已绑定的比赛机运行 `submit a.cpp`、`submit status` 或 `submit print a.cpp`。[座位与 IP](docs/usage.md#座位与-ip) · [选手命令行](docs/usage.md#选手命令行-submit)
- **榜单与奖项**　金银铜可混用固定队数和比例，打星队可按分榜规则领取奖牌。优胜奖可设最低过题数，CCPC 题号可按队数和比例中较小的门槛公开。可预约赛后自动解封，观众可切换女队榜、用正则置顶队伍或回放指定时点。[奖项规则](docs/usage.md#规则)
- **现场与直播**　气球台可按队伍和题目定位待送气球。导播可识别和刷新在线 OBS 浏览器来源，也可为每队榜单行开启提交时间轴。[直播操作](docs/usage.md#直播)
- **滚榜与颁奖**　主持页和观众大屏可在原版 2D、CCPCOJ 一代与 CCPCOJ 二代三种滚榜样式之间切换。颁奖页可将当前名单和版式导出为可编辑的 PowerPoint。[颁奖幻灯片](docs/usage.md#颁奖幻灯片)

## 快速安装

**从 v2.3.0 或更早版本升级**　升级后首次启动 Hydro 时，插件会永久清除历届比赛的证书配置、签发记录和上传素材。旧领取链接和验真二维码随之失效。需要留档时，请在升级前备份证书数据。[备份范围](docs/usage.md#升级前备份证书数据)

需要 Hydro 5.x 和 Node.js 22 或更高版本。用运行 Hydro 的系统账号下载并校验 v2.6.0 安装包。使用自定义 profile、容器或其他进程管理器时，请按部署方式选择安装步骤。[安装与升级图解](https://albert-li-sz.github.io/Hydro-Contest-Better/#install)

```sh
release=https://github.com/Albert-Li-Sz/Hydro-Contest-Better/releases/download/v2.6.0
package=hydro-scoreboard-xcpcio-plus-2.6.0.tgz
mkdir -p hydro-contest-2.6.0 && cd hydro-contest-2.6.0
curl -fLO "$release/$package" && curl -fLO "$release/$package.sha256"
sha256sum -c "$package.sha256" && tar -xzf "$package"
```

首次安装运行 `bash package/install.sh install`。升级已有插件运行 `bash package/install.sh upgrade`。默认安装在 `$HOME/.hydro/addons/hydro-scoreboard-xcpcio-plus`，脚本会备份旧版本并重启 PM2 的 `hydrooj` 服务。

## 配置第一场比赛

1. 用比赛所有者或具备「编辑比赛」权限的账号打开一场 ACM 比赛，从右侧菜单进入 **比赛配置与工作台**。
2. 在 **赛制与奖项** 选择 Hydro、ICPC 区域赛或 CCPC，核对同分规则和奖牌名额。在 **公开与访问** 决定观众可以看到哪些内容。
3. 在 **赛事工作台** 打开机位签到、答疑或评测监控。现场投屏与 OBS 使用 **采集与播出** 中的入口。[图文操作指南](https://albert-li-sz.github.io/Hydro-Contest-Better/#configuration)

| 要做的事 | 教程 |
| --- | --- |
| 赛前导入座位、签到和分配答疑员 | [机位签到](https://albert-li-sz.github.io/Hydro-Contest-Better/#presence) · [答疑与公告](https://albert-li-sz.github.io/Hydro-Contest-Better/#clarifications) |
| 送气球、打小票或打印选手代码 | [气球配送](https://albert-li-sz.github.io/Hydro-Contest-Better/#balloons) · [比赛打印](https://albert-li-sz.github.io/Hydro-Contest-Better/#print) |
| 投屏、直播、录制屏幕和摄像头 | [大屏](https://albert-li-sz.github.io/Hydro-Contest-Better/#screens) · [导播与 OBS](https://albert-li-sz.github.io/Hydro-Contest-Better/#broadcast) · [双路留档](https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.html#screen-archive) |
| 连接媒体机并制作反应视频 | [Docker Compose 安装](https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.html#install) · [首条成品](https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.html#render) |
| 裁判改判、比对相似代码或核验录像 | [裁判操作与诚信复核](https://albert-li-sz.github.io/Hydro-Contest-Better/#jury-integrity) |
| 制作颁奖台本、播放离线幻灯片或导出 PowerPoint | [赛后滚榜](https://albert-li-sz.github.io/Hydro-Contest-Better/#resolver) · [颁奖幻灯片](https://albert-li-sz.github.io/Hydro-Contest-Better/#ceremony) |
| 复核重测结果、导出获奖名单或对接 CCS | [赛后滚榜](https://albert-li-sz.github.io/Hydro-Contest-Better/#resolver) · [成绩与导出](https://albert-li-sz.github.io/Hydro-Contest-Better/#results) · [CCS API](https://albert-li-sz.github.io/Hydro-Contest-Better/#integration) |

媒体机是可选组件。在 **采集与播出 → 媒体机连接** 创建连接，将复制的 `HYDRO_MEDIA_CONNECTION` 写入媒体机的 `.env`，再用 Docker Compose 启动。插件 v2.6.0 配用媒体机镜像 `ghcr.io/albert-li-sz/reactions-generator-hydro:2.3.0`，支持 Linux amd64 和 arm64。[Compose 配置](https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.compose.yaml)

## 开发与许可

构建两个客户端需要 Go 1.22 或更高版本。使用项目声明的 pnpm 版本执行 `pnpm install --frozen-lockfile`、`pnpm build:print-client`、`pnpm build:submit-client` 和 `pnpm build`。`pnpm preview` 启动演示比赛，`pnpm test`、`pnpm typecheck` 和 `pnpm test:ui` 分别验证业务逻辑、Hydro API 和浏览器交互。[验证记录](docs/verification.md)

本项目自研代码采用 MIT 许可证。第三方集成组件、字体、标识及参考素材分别保留各自原有许可与权利归属，不适用本项目的 MIT 许可：

- **Hydro 适配与第三方开源组件**　XCPCIO、Resolver-Web、ICPC Live、reactions-generator、fix-webm-duration、Noto Sans SC 均保留各自上游许可。早期源自 Hydro `scoreboard-xcpcio` 的集成代码保留其来源声明。
- **ICPC Tools 许可限制声明**：Resolver 与大屏中包含源自 ICPC Tools 的引擎、绘图及资源文件，受 `ICPC Software License` 约束（禁止未经 ICPC Foundation 书面许可的商业或创收使用，且授权方可撤销），与本项目 MIT 许可相互独立。

[项目许可证（MIT）](LICENSE) · [第三方与合规声明](NOTICE) · [许可证目录](licenses/)
