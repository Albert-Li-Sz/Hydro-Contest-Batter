# Hydro Contest Better

[![GitHub Release](https://img.shields.io/github/v/release/Albert-Li-Sz/Hydro-Contest-Better?label=release)](https://github.com/Albert-Li-Sz/Hydro-Contest-Better/releases/latest)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Hydro OJ 的 ACM 办赛插件。工作人员可以在 Hydro 内配置赛制与奖项、运行答疑和气球配送、录制选手机位、向大屏和 OBS 播出比赛，并在赛后滚榜、核查诚信、导出成绩和签发获奖证书。

[快速安装](#快速安装) · [比赛操作手册](https://albert-li-sz.github.io/Hydro-Contest-Better/) · [媒体机安装教程](https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.html) · [版本下载](https://github.com/Albert-Li-Sz/Hydro-Contest-Better/releases/latest)

## v2.2.0 更新

- **直播导播**单独上屏一支队伍时，底部可以选「校名队伍卡」（校徽、校名、队名、队员与教练、座位号）或「曲线时间线」（提交时间线叠加过题面积与排名折线，封榜后改为虚线），也可以不展示。双队对比、四分屏等多队同时上屏时，底部栏和成就图自动隐藏。学校、教练和座位遵循「向所有观众显示学校」。[单队底部栏](https://albert-li-sz.github.io/Hydro-Contest-Better/#single-team-bottom-bar)
- **操作手册**改为文档站布局：分组目录、本页目录、深浅色切换、代码一键复制，手机上用抽屉目录。[比赛操作手册](https://albert-li-sz.github.io/Hydro-Contest-Better/)

## 快速安装

需要 Hydro 5.x 和 Node.js 22 或更高版本。以运行 Hydro 的系统用户执行以下 Linux 命令。使用自定义 profile、容器或其他进程管理器时，请按部署方式选择安装步骤。[安装与升级图解](https://albert-li-sz.github.io/Hydro-Contest-Better/#install)

```sh
release=https://github.com/Albert-Li-Sz/Hydro-Contest-Better/releases/download/v2.2.0
package=hydro-scoreboard-xcpcio-plus-2.2.0.tgz
mkdir -p hydro-contest-2.2.0 && cd hydro-contest-2.2.0
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
| 制作颁奖台本与离线幻灯片，设计、签发与更正双语证书 | [赛后滚榜](https://albert-li-sz.github.io/Hydro-Contest-Better/#resolver) · [颁奖幻灯片](https://albert-li-sz.github.io/Hydro-Contest-Better/#ceremony) · [证书制作与领取](https://albert-li-sz.github.io/Hydro-Contest-Better/#certificates) · [中文赛事模板与左侧标识样张](docs/examples/certificate-event-zh.pdf) · [赛事模板与自定义签名样张](docs/examples/certificate-event.pdf) · [五套横竖版样张](docs/examples/certificate-styles.pdf) |
| 复核重测结果、导出获奖名单或对接 CCS | [赛后滚榜](https://albert-li-sz.github.io/Hydro-Contest-Better/#resolver) · [成绩与导出](https://albert-li-sz.github.io/Hydro-Contest-Better/#results) · [CCS API](https://albert-li-sz.github.io/Hydro-Contest-Better/#integration) |

媒体机是可选组件。在 **采集与播出 → 媒体机连接** 创建连接，将复制的 `HYDRO_MEDIA_CONNECTION` 写入媒体机的 `.env`，再用 Docker Compose 启动。插件 v2.2.0 搭配公共镜像 `ghcr.io/albert-li-sz/reactions-generator-hydro:2.2.0`，支持 Linux amd64 和 arm64。[Compose 配置](https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.compose.yaml)

## 开发与许可

使用项目声明的 pnpm 版本执行 `pnpm install --frozen-lockfile`、`pnpm build:print-client` 和 `pnpm build`。`pnpm preview` 启动演示比赛，`pnpm test`、`pnpm typecheck` 和 `pnpm test:ui` 分别验证业务逻辑、Hydro API 和浏览器交互。[验证记录](docs/verification.md)

本项目自研代码采用 MIT 许可证。第三方集成组件、字体、标识及参考素材分别保留各自原有许可与权利归属，不适用本项目的 MIT 许可：

- **Hydro 适配与第三方开源组件**：XCPCIO、Resolver-Web、ICPC Live、reactions-generator、pinyin-pro、fix-webm-duration、Noto Sans SC 均保留各自上游许可；早期源自 Hydro `scoreboard-xcpcio` 的集成代码保留其来源声明。
- **ICPC Tools 许可限制声明**：Resolver 与大屏中包含源自 ICPC Tools 的引擎、绘图及资源文件，受 `ICPC Software License` 约束（禁止未经 ICPC Foundation 书面许可的商业或创收使用，且授权方可撤销），与本项目 MIT 许可相互独立。
- **证书赛事模板、个人手写签名与字体免责声明**：`lib/certificates/event-art/`、`lib/certificates/event-fonts/` 与 `resolver/public/js/certificate-event/` 中附带的 2026 ICPC 沈阳区域赛抬头、徽标、个人手写签名样例及嵌入的 Arial 字体子集，均归原权利人（ICPC Foundation、相关签署人及 Monotype/字体权利人）所有，**不属于本项目 MIT 授权范围**，仅作排版与替换功能参考演示。赛事主办方在正式签发证书前，务必在证书编辑器中替换或清除所有第三方徽标、默认个人签名与专有字体，严禁未经授权用于对外颁证或冒用官方名义。

[项目许可证（MIT）](LICENSE) · [第三方与合规声明](NOTICE) · [许可证目录](licenses/)
