---
summary: 用 Docker 在服务器上长期运行 NekroNXT，以及数据目录、升级和重启。
ui: []
routes: []
keywords: [Docker, 服务端, Compose, 升级, 镜像, 数据目录]
---

# Docker 部署

NekroNXT 服务端（Server）适合长期在线运行。一个容器保存全部程序，`/data` 保存需要持久化的数据。

## 启动容器

准备 Docker，把 `<管理密钥>` 替换为至少 32 个字符的随机字符串，把 `<持久化目录>` 替换为宿主机上的数据目录：

```bash
docker run -d \
  --name nekro-nxt \
  --restart unless-stopped \
  -p 127.0.0.1:4960:4960 \
  -e NEKRO_MANAGEMENT_KEY='<管理密钥>' \
  -e TZ='Asia/Shanghai' \
  -v '<持久化目录>:/data' \
  ghcr.io/nekroai/nekro-nxt:latest
```

镜像同时提供 x86_64（amd64）和 ARM64 两种架构，适用于常见的 x86 服务器，也适用于树莓派 4/5、ARM 云服务器和 ARM 架构的 NAS；Docker 会自动拉取与宿主机匹配的版本。

Android 只允许 root 和网络权限组（GID 3003）的进程联网，镜像的运行用户已经加入这个组。如果在 Android 上启动时仍提示「不允许当前用户监听网络端口」，加上 `-e NEKRO_UID=0 -e NEKRO_GID=0` 让服务以 root 运行。

在国内网络下拉取 `ghcr.io` 较慢或失败时，可以把镜像地址换成 Docker Hub 上的同一镜像 `kromiose/nekro-nxt:latest`（正式版同时发布到两处，内容一致，版本说明里列出了镜像摘要可以核对）。

`TZ` 是服务端所在的时区（IANA 名称），决定智能体看到的消息时间和定时任务的默认时区；不设置时容器使用 UTC。请设为频道成员实际所在的时区，否则成员说「下午三点」时，智能体会按 UTC 理解。

需要从其他设备或公网访问时，见[通过公网和 HTTPS 访问](https.md)。

启动后用浏览器打开 `http://127.0.0.1:4960`，输入管理密钥登录即可使用网页界面；这台浏览器会保持登录 30 天。也可以在桌面版的实例菜单中添加这台服务端。

## Docker Compose

仓库中的 [`docker-compose.yml`](../../../docker-compose.yml) 使用正式版镜像、命名数据卷和自动重启策略：

```bash
git clone https://github.com/NekroAI/nekro-nxt.git
cd nekro-nxt
NEKRO_MANAGEMENT_KEY='<至少32个字符的管理密钥>' TZ='Asia/Shanghai' docker compose up -d
```

查看状态与日志：

```bash
docker compose ps
docker compose logs -f nekro-nxt
```

## 从源码构建镜像

需要验证当前检出或修改服务端代码时，可以构建本地镜像：

```bash
NEKRO_IMAGE='nekro-nxt:local' pnpm dist:server
```

然后把上方 `docker run` 命令末尾的镜像名替换为 `nekro-nxt:local`。

不能使用 Docker 时，可以参考社区整理的[不用 Docker 部署服务端](node.md)。这种方式不在官方支持范围内。

## 重启服务

「设置 → 关于」中的「重启服务」会让服务正常关闭后退出，再由容器的重启策略启动。容器需要配置重启策略（例如上面的 `--restart unless-stopped` 或 Compose 中的 `restart: unless-stopped`），否则服务停止后不会自动启动。重启以退出码 75 结束进程，只认非零退出码的 `on-failure` 策略同样有效。智能体也可以请求重启，请求发在频道里，管理员发送 `/ext approve 编号` 或在工坊的「扩展请求」中同意后才会执行。

## 智能体的命令

镜像里的命令可以使用 `git`、`curl`、`python3`、`pip3`、`node`、`npm`、`jq`、`rg`、`unzip`、`zip`、`xz`、`ssh`、`ps` 和 `ffmpeg`。命令以运行用户（默认 UID 10001）执行，没有 sudo，不能用 apt 安装软件。

开了「完整访问」的智能体把自己需要的工具装到 `/data/tools`，容器重建后仍在：`npm install -g` 装到 `/data/tools/npm`，`pip install --user` 装到 `/data/tools/python`，虚拟环境建在 `/data/tools/venv/<名字>`，单个程序放进 `/data/tools/bin`；这几处的 `bin` 目录都在命令的 `PATH` 里。只能写工作区的智能体也能使用这里已装好的工具。`/data/tools` 不进升级恢复点；恢复后需要的工具重新安装即可。

## 数据目录与升级

智能体、会话、扩展、资源、证书和工作区都位于 `/data`。容器启动时会把 `/data` 交给运行用户（默认 UID/GID 10001），宿主机目录无需提前设置属主；需要与宿主机其他程序共用文件时，可用 `NEKRO_UID`、`NEKRO_GID` 指定运行用户。

升级时拉取新镜像并替换容器，不要在运行容器内执行 `git pull`：

```bash
docker pull ghcr.io/nekroai/nekro-nxt:latest   # 或 docker pull kromiose/nekro-nxt:latest
docker stop nekro-nxt
docker rm nekro-nxt
```

随后重新执行“启动容器”中的命令，继续挂载原持久化目录。升级前先备份完整 `/data`；详细恢复原则见[升级、备份与恢复](../ops/upgrade-backup.md)。新版本启动时会先在 `/data/backups/` 生成恢复点，可以用 `NEKRO_UPGRADE_BACKUP_DIR` 改到另一个挂载的目录，或用 `NEKRO_UPGRADE_BACKUP=off` 关闭。
