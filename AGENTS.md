# 服务器部署说明（给协助部署的 agent 阅读）

这台服务器托管本站，以及后续要部署的后端服务和数据库。本文档描述如何连接、文件放在哪里、部署怎么做。违规操作会直接影响线上站点，动手前请先读完。

## 连接方式

```
ssh blogserver
```

等价于：

```
ssh -p 443 -i ~/.ssh/id_ed25519_agents root@47.238.233.55
```

- 主机：`47.238.233.55`（阿里云香港 ECS，Ubuntu 22.04，2 核 4G，系统盘 40G）
- 用户：`root`
- **端口是 443，不是 22**。22 端口从国内访问会被链路干扰，443 是唯一稳定通道（nginx 把非 TLS 流量转给 sshd）
- 密钥：`~/.ssh/id_ed25519_agents`（本地文件，无口令）

### 链路不稳定时

从国内到这台香港服务器的连接会**间歇性被阻断**，表现为 TCP 能连上但立即被关闭（不是服务器故障）。遇到这种情况：

1. 先等十几秒重试，多数情况会自动恢复
2. 连续失败时，检查本机是否开了 Clash 等代理软件的 TUN 模式，它会劫持 SSH 流量
3. 如果长时间不通，用 `ping 47.238.233.55` 确认服务器在线；ping 通但端口不通就是链路问题，不是服务器问题

**不要**因为连不上就重启服务器或修改 sshd 配置。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `/opt/blog` | 博客源码（Vite + React），git 仓库 |
| `/var/www/lingluan-blog` | 线上静态站点，nginx 的 root 指这里 |
| `/opt/blog/admin` | 博客后台服务代码（systemd 单元 `blog-admin`） |
| `/opt/apps` | **新部署的软件放这里**，每个项目一个子目录 |
| `/etc/nginx/sites-available/lingluan-blog` | 站点 nginx 配置 |

## 正在运行的服务

- `nginx`：80 端口提供静态站点
- `blog-admin`：监听 `127.0.0.1:3001`，博客后台，仅本机访问

查看：`systemctl is-active nginx blog-admin`

## 部署静态站点

源码在 `/opt/blog`，构建后用 `dist/` 覆盖站点目录：

```bash
cd /opt/blog
pnpm build
rsync -a --delete dist/ /var/www/lingluan-blog/
```

注意 `--delete` 会清掉站点目录里不在 `dist` 中的文件，这是预期行为（构建产物文件名带 hash，旧文件必须清掉）。

## 部署后端服务或数据库

1. 代码放 `/opt/apps/<项目名>`
2. 用 systemd 管理进程，单元写到 `/etc/systemd/system/<项目名>.service`
3. **新增端口必须放行两层**：服务器上的 ufw（`ufw allow <端口>/tcp`）和阿里云控制台的安全组（入方向）
4. 只监听 `127.0.0.1` 的服务由 nginx 反代暴露，不要直接把数据库端口暴露到公网
5. 数据库数据目录放在 `/opt/apps/<项目名>/data`，不要放在系统目录

## 禁止事项

这些操作会影响线上的博客和访问通道，请先征得用户同意：

- 修改 `/etc/ssh/sshd_config`、移除 `/root/.ssh/authorized_keys` 里的密钥（会导致所有人失去访问）
- 改动 `/etc/nginx/sites-available/lingluan-blog` 中博客站点的 root 和 location
- 读取或修改 `/etc/blog-admin/env`（后台密码哈希）
- 停止 `nginx`、`blog-admin` 服务
- 在 `/var/www/lingluan-blog` 里手工放文件（下次构建会被 `--delete` 清掉，应改源码而不是改产物）

## 已知待办

无。域名解析、HTTPS 证书、端口分流均已完成。

## 域名与端口分流

- 站点域名：`lingluandf.online` 和 `www.lingluandf.online`，A 记录指向本机
- HTTPS 证书由 Let's Encrypt 签发，certbot 定时任务自动续期
- **443 端口由 nginx 的 stream 模块分流**：
  - TLS 流量（ClientHello）→ `127.0.0.1:8443`（nginx 的 https server）
  - 非 TLS 流量 → `127.0.0.1:22`（sshd）
- 所以 SSH 和网站共用 443，不要以为 443 只归 nginx
- 后台地址：`https://lingluandf.online/admin/`（nginx 反代到 `127.0.0.1:3001`）
- stream 配置文件：`/etc/nginx/stream-ssh-https.conf`，由 `/etc/nginx/nginx.conf` 末尾的 include 引入