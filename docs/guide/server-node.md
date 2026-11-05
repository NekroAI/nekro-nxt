# 不用 Docker 部署服务端（非官方）

> **非官方支持，仅供参考。** 官方支持的服务端部署方式是 [Docker 镜像](server.md)。本文整理自社区成员的实测记录（[#83](https://github.com/NekroAI/nekro-nxt/issues/83)），适合拉不到镜像、装不了 Docker，或者需要把服务纳入现有 systemd 体系的场合。按本文部署时遇到问题，请先确认同一版本在 Docker 里是否正常；沙箱行为、运行用户的权限和系统加固需要你自己负责。

## 思路

镜像没有特殊的运行方式。它的启动脚本只做两件事：把 `/data` 交给运行用户（默认 UID/GID 10001），再降权运行 `node /opt/nekro/server/dist/main.mjs`。所以不用 Docker 时，等价做法是：

- 从镜像里取出 `/opt/nekro` 运行时，不从源码构建；
- 准备同一主版本的 Node.js 22；
- 用一个专用的普通用户运行，数据目录仍放在 `/data`；
- 设置与镜像相同的环境变量，用 systemd 托管进程。

社区实测环境：Ubuntu 24.04、Node.js 22、x86_64，从长期运行的 Docker 实例迁出，数据完整。

## 取出运行时

```bash
docker create --name nxt-extract ghcr.io/nekroai/nekro-nxt:latest
docker cp nxt-extract:/opt/nekro /opt/nekro
docker rm nxt-extract
```

这一步需要一台能运行 Docker 的机器，取出后把 `/opt/nekro` 拷到目标机器即可。运行时目录要保持 `/opt/nekro` 这个路径，所在的磁盘不能以 `noexec` 挂载，否则 Node.js 和内置浏览器无法执行。

同时用 `docker image inspect` 查看镜像的 `Env`，后面的环境变量照它填写，尤其是 `NEKRO_RELEASE_ID`。

还需要：

- Node.js 22（与镜像里的版本一致更稳妥），例如解压到 `/opt/node22`；
- 中文字体（镜像里是 `fonts-wqy-microhei`），渲染图片时需要；
- ffmpeg（媒体处理用，也可以在「设置 → 附加功能」里下载）；
- 内置浏览器的系统依赖：精简系统上缺库时，可以用 Playwright 的 `install-deps` 补齐。

## 准备用户和数据目录

```bash
groupadd --gid 10001 nekro
useradd --uid 10001 --gid 10001 --home-dir /data --no-create-home --shell /usr/sbin/nologin nekro
mkdir -p /data && chown 10001:10001 /data
```

- 不要用 root 运行。没有容器隔离时，智能体的命令和扩展的本机程序都直接以这个用户身份运行在宿主机上。
- 数据目录必须是真实的 `/data`，不能是符号链接。数据放在别的磁盘时，用 bind mount 挂到 `/data`。原因是会话存储记录了 `/data/dsh/sessions` 这个绝对路径，恢复点目录也不接受符号链接。

从 Docker 实例迁移时，先停掉容器，再把数据卷的内容整体搬到 `/data`，保持属主为 `10001:10001`。跨磁盘用 `rsync -aHAX --numeric-ids`。

## systemd

`/etc/nekro-nxt.env`（权限 600）：

```bash
NODE_ENV=production
NEKRO_DATA=/data
NEKRO_DIST_INDEX=/opt/nekro/web/dist/index.html
NEKRO_VERIFICATION_BROWSER_ROOT=/opt/nekro/chromium
NEKRO_RELEASE_ID=<照镜像 Env 填写>
NEKRO_HOST=127.0.0.1
NEKRO_PORT=4960
NEKRO_MANAGEMENT_KEY=<管理密钥，迁移时沿用原值>
TZ=Asia/Shanghai
HOME=/data
```

前面有反向代理时，`NEKRO_HOST` 保持 `127.0.0.1`；需要直接对外访问时改成 `0.0.0.0`，并在防火墙中限制访问范围。

`/etc/systemd/system/nekro-nxt.service`：

```ini
[Unit]
Description=NekroNXT server
After=network-online.target
Wants=network-online.target
RequiresMountsFor=/data /opt/nekro

[Service]
Type=simple
User=nekro
Group=nekro
WorkingDirectory=/data
EnvironmentFile=/etc/nekro-nxt.env
Environment=PATH=/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/opt/node22/bin/node /opt/nekro/server/dist/main.mjs
Restart=always
RestartSec=5
TimeoutStopSec=45
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now nekro-nxt
```

`RequiresMountsFor` 保证 bind mount 先于服务挂好。`ProtectSystem`、`PrivateTmp` 这类加固会影响扩展构建和命令执行，按需自行评估。

## 启动后

- 新版本第一次启动时会先生成升级恢复点，期间管理接口返回 `host-upgrading`，等一两分钟即可。
- 升级没有完成、进入恢复状态后，每次启动都会报同一个原因。排除问题后，以服务用户和同样的环境变量手动运行一次 `node /opt/nekro/server/dist/main.mjs --retry-upgrade`，完成后再用 systemd 启动。
- 运行日志在 `/data/logs/logs.sqlite`，也可以在网页的「日志」里查看。

## 从 Docker 迁过来要改的配置

保存在数据库里的「容器内地址」不会自动改变，需要在界面上逐个改掉：

- 连接里写的 Docker 服务名，例如 `ws://napcat:3001/`。宿主机解析不了这类名字，改成宿主机上能访问的地址。
- 扩展配置里指向其他容器的地址。

## 升级

1. 用新镜像重新取出 `/opt/nekro`，并更新 `NEKRO_RELEASE_ID`。
2. 停止服务，备份 `/data`（至少 `core.sqlite` 和 `dsh/`；不停服务时用 `sqlite3 /data/core.sqlite ".backup <目标>"`，直接复制可能不一致）。
3. 替换运行时后启动服务。

社区记录没有完整走过一次裸机升级；环境变量和目录结构可能随版本变化，升级前对照新镜像的 `Env`。
