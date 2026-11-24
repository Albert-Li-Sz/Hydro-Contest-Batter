# Hydro 反应视频媒体机

在 Hydro 比赛侧边栏打开 **反应视频 → 媒体机**，生成令牌并复制接口地址。以下命令在负责合成视频的机器上执行。接口地址包含本场令牌。

## 使用公共镜像

Linux amd64 和 arm64 均可使用同一个版本标签。在终端执行第一行，粘贴媒体机接口地址并回车，再启动容器。

```sh
read -r HYDRO_REACTIONS_API
docker run -d --name hydro-reactions --restart unless-stopped \
  -v "$PWD/out:/app/out" ghcr.io/albert-li-sz/reactions-generator-hydro:1.21.0 \
  all "$HYDRO_REACTIONS_API" --hydro-upload
```

回到比赛管理页，刷新「媒体机心跳」，正常连接时会显示机器名和在线状态。使用 Docker Compose 的完整步骤见 [媒体机教程](https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.html)。

## 从源码构建

从 [v1.21.0 发布页](https://github.com/Albert-Li-Sz/Hydro-Contest-Better/releases/tag/v1.21.0) 下载 `reactions-generator-hydro-1.21.0.tar.gz`。解压后进入含 Dockerfile 的目录，将本场接口地址写入本地 `.env` 并启动。

```sh
read -r HYDRO_REACTIONS_API
(umask 077 && printf 'HYDRO_REACTIONS_API=%s\n' "$HYDRO_REACTIONS_API" > .env)
docker compose up -d --build
```

本机也可使用 Python 3.12、Poetry 和系统 FFmpeg/FFprobe，在发布附件的解压目录运行 `poetry install` 后执行 `poetry run main all '比赛媒体机地址' --hydro-upload`。已有 Pillow、requests 和 FFmpeg 的环境可以直接运行 `python3 reactions_generator/hydro_worker.py all '比赛媒体机地址' --hydro-upload`。苹果编码参数为 `--hardware apple`，NVIDIA 编码为 `--hardware nvidia`，Intel QSV 为 `--hardware qsv`。Linux VAAPI 可用 `--hardware vaapi`；为容器映射 /dev/dri。NVIDIA Container Toolkit 可用 `--gpus all`；`--hardware nvidia_full` 使用 CUDA 叠加画面。

两台独立机器分别使用 `--total-workers 2 --worker-id 0` 和 `--total-workers 2 --worker-id 1`。省略分区号时在同一台机器上执行所有分区。每 15 秒更新心跳。输出按比赛、提交、版式和任务代次隔离，上传中断可复用已编码文件。渲染失败后在管理页选择重新渲染；本地保留该代的 .err 记录。默认使用 CPU；赛场启用硬件编码前可用上游的 `main benchmark` 测量机器性能。

源程序基于 icpc/reactions-generator 的 5d42acb846870b032605d161cf26f26ca556e77e，原有命令、字体和音效随发布附件提供。附件中的 LICENSE 对应上游 pyproject.toml 声明的 MIT 许可，素材出处见 example/README.md 和 fonts 目录。项目新增的 Hydro 适配遵循插件根目录的 AGPL-3.0-or-later，中文字体授权见 reactions_generator/fonts/Noto-Sans-SC-OFL.txt。
