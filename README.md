# Hydro Contest Better

[![GitHub Release](https://img.shields.io/github/v/release/Albert-Li-Sz/Hydro-Contest-Better?label=release)](https://github.com/Albert-Li-Sz/Hydro-Contest-Better/releases/latest)
[![AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

Hydro OJ 的 ACM 办赛插件。工作人员可以在 Hydro 内配置赛制与奖项、运行答疑和气球配送、录制选手机位、向大屏和 OBS 播出比赛，并在赛后滚榜和导出成绩。

[快速安装](#快速安装) · [比赛操作手册](https://albert-li-sz.github.io/Hydro-Contest-Better/) · [媒体机安装教程](https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.html) · [版本下载](https://github.com/Albert-Li-Sz/Hydro-Contest-Better/releases/latest)

## 快速安装

需要 Hydro 5.x 和 Node.js 22 或更高版本。以运行 Hydro 的系统用户执行以下 Linux 命令。使用自定义 profile、容器或其他进程管理器时，请按部署方式选择安装步骤。[安装与升级图解](https://albert-li-sz.github.io/Hydro-Contest-Better/#install)

```sh
release=https://github.com/Albert-Li-Sz/Hydro-Contest-Better/releases/download/v1.23.0
package=hydro-scoreboard-xcpcio-plus-1.23.0.tgz
mkdir -p hydro-contest-1.23.0 && cd hydro-contest-1.23.0
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
| 滚榜、复核重测结果、导出获奖名单或对接 CCS | [赛后滚榜](https://albert-li-sz.github.io/Hydro-Contest-Better/#resolver) · [成绩与导出](https://albert-li-sz.github.io/Hydro-Contest-Better/#results) · [CCS API](https://albert-li-sz.github.io/Hydro-Contest-Better/#integration) |

媒体机是可选组件。在 **采集与播出 → 媒体机连接** 创建连接，将复制的 `HYDRO_MEDIA_CONNECTION` 写入媒体机的 `.env`，再用 Docker Compose 启动。插件 v1.23.0 搭配公共镜像 `ghcr.io/albert-li-sz/reactions-generator-hydro:1.23.0`，支持 Linux amd64 和 arm64。[Compose 配置](https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.compose.yaml)

## 开发与许可

使用项目声明的 pnpm 版本执行 `pnpm install --frozen-lockfile`、`pnpm build:print-client` 和 `pnpm build`。`pnpm preview` 启动演示比赛，`pnpm test`、`pnpm typecheck` 和 `pnpm test:ui` 分别验证业务逻辑、Hydro API 和浏览器交互。[验证记录](docs/verification.md)

插件及 Hydro 适配代码使用 AGPL-3.0-or-later。XCPCIO、Resolver-Web、ICPC Live 与 reactions-generator 分别保留上游许可。Resolver 中的 ICPC Tools 内容受 ICPC Software License 的非商业使用等条款约束。[插件许可证](LICENSE) · [第三方声明](NOTICE) · [许可证目录](licenses/)
