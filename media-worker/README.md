# Hydro 反应视频媒体机

在 Hydro 比赛侧边栏打开 **反应视频与渲染 → 媒体机**，为这台机器创建连接，复制完整连接码。每个节点使用自己的连接码，管理员可以单独轮换或撤销。下面的命令都在负责合成视频的电脑上执行。

## 配置连接

进入部署目录，用文本编辑器创建 `.env`。将下面等号右侧替换成管理页复制的完整连接码，然后保存。Linux 和 macOS 上执行 `chmod 600 .env`。

```dotenv
HYDRO_MEDIA_CONNECTION=hydro-reactions:在这里粘贴完整连接码
```

## 使用公共镜像

Linux amd64 和 arm64 可以使用同一版本标签。在含 `.env` 的目录运行：

```sh
curl -fL https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.compose.yaml -o compose.yaml
docker compose pull
docker compose up -d
```

回到比赛管理页刷新「媒体机心跳」即可确认上线。Compose 配置、实际录制和故障排查见[媒体机教程](https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.html)。

## 从源码构建或本机运行

从 [v1.27.2 发布页](https://github.com/Albert-Li-Sz/Hydro-Contest-Better/releases/tag/v1.27.2) 下载 `reactions-generator-hydro-1.27.2.tar.gz`，解压后进入含 Dockerfile 的目录。在本目录保存上述 `.env`，运行 `docker compose up -d --build`。

本机运行需要 Python 3.12、Poetry 及系统 FFmpeg/FFprobe。运行 `poetry install` 后在同一目录执行 `poetry run main all --hydro-upload`。Apple 芯片可使用 `poetry run main all --hydro-upload --hardware apple`。已有 Pillow、requests 和 FFmpeg 的环境可以运行 `python3 reactions_generator/hydro_worker.py all --hydro-upload`。NVIDIA 编码为 `--hardware nvidia`，Intel QSV 为 `--hardware qsv`。Linux VAAPI 可用 `--hardware vaapi` 并为容器映射 /dev/dri。NVIDIA Container Toolkit 可用 `--gpus all`；`--hardware nvidia_full` 使用 CUDA 叠加画面。

轮换连接码后，更新本机 `.env`，运行 `docker compose up -d --force-recreate`，使连接文件重新挂载。

已有部署的 `HYDRO_REACTIONS_API` 和旧 URL 命令仍然支持。切换至每台设备独立连接时，将 `.env` 中的地址替换为 `HYDRO_MEDIA_CONNECTION` 并用新版 Compose 配置重新创建容器。

两台独立机器分别使用 `--total-workers 2 --worker-id 0` 和 `--total-workers 2 --worker-id 1`。省略分区号时在同一台机器上执行所有分区。每 15 秒更新心跳。输出按比赛、提交、版式和任务代次隔离，上传中断可复用已编码文件并按单任务指数退避，常驻模式在上传完成后自动清理本地成片以防占满磁盘。渲染失败后在管理页选择重新渲染；本地保留该代的 .err 记录。默认使用 CPU；赛场启用硬件编码前可用上游的 `main benchmark` 测量机器性能。

源程序基于 icpc/reactions-generator 的 5d42acb846870b032605d161cf26f26ca556e77e，原有命令、字体和音效随发布附件提供。附件中的 LICENSE 对应上游 pyproject.toml 声明的 MIT 许可，素材出处见 example/README.md 和 fonts 目录。项目新增的 Hydro 适配遵循插件根目录的 MIT 许可（附件中随附 `LICENSE-Hydro-MIT.txt` 与 `NOTICE`），中文字体授权见 reactions_generator/fonts/Noto-Sans-SC-OFL.txt。

## 成片版式

竖屏为 1080 × 1920，横屏为 1920 × 1080，均使用 ICPC reactions-generator 的位置、图层顺序与成绩卡动画。成绩卡在队名前显示学校校徽，未匹配校徽时留空。管理员可替换竖屏底部的 1080 × 192 像素图样。赛中录制的帧率和留档编码独立于成片编码。
