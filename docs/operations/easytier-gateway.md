# EasyTier 零配对组网与公网网关部署指南

本文介绍如何使用 **EasyTier 虚拟局域网 + 公网网关模式** 连接所有运行 Quixotic 的设备：

- **电脑 / 服务器互连（零配对）**：只要设备接入同一个 EasyTier 子网（例如 `10.126.126.0/24`）并运行 Quixotic，彼此会**自动发现并出现在「环境」列表中**，无需手动生成/输入配对码，也不依赖 Tailscale、T3 Connect 云中继或 SSH 隧道。
- **手机远程控制（免装 EasyTier）**：手机端（App 或浏览器）只需访问部署在云服务器上的**公网网关地址**（例如 `http://203.0.113.10:3773` 或 `https://quixotic.example.com`），使用**网关访问密码**登录一次，即可自动发现并远程控制 EasyTier 内网中的所有在线机器。

---

## 架构概览

```text
[手机 App / 手机浏览器]  (无需安装 EasyTier)
        │  公网 IP / HTTPS + 网关访问密码 (HTTP + WebSocket)
        ▼
[云服务器 Quixotic 公网网关]  (公网 IP: 203.0.113.10:3773 / EasyTier IP: 10.126.126.254)
        │  鉴权通过后，通过 /mesh/<environmentId>/* & /mesh/<environmentId>/ws 反代
        ├──────────────► [Windows 电脑 A]  10.126.126.10:3773 (EasyTier 零配对直连)
        ├──────────────► [Linux 开发机 B]  10.126.126.20:3773 (EasyTier 零配对直连)
        └──────────────► [NAS / 工作站 C]  10.126.126.1:3773  (EasyTier 零配对直连)
```

### 安全边界

1. **零配对仅限 EasyTier 直连流量**：
   - 服务端仅当原始 TCP Socket 对端 IP 属于本机 EasyTier 网段（如 `10.126.126.0/24`）**且请求不含任何代理转发头**（`X-Forwarded-For`、`Forwarded`、`X-Real-IP`、`CF-Connecting-IP`、`True-Client-IP`）时，才允许 `/api/easytier/mesh-session` 和 `/api/easytier/mesh-browser-session` 免配对签发会话。
   - 公网访问（包括经过 Nginx/Caddy 反代的流量）**永远不会**被误判为 EasyTier 直连。
2. **公网网关强鉴权**：
   - 所有经由公网访问 `/api/easytier/status`、`/mesh/<environmentId>/*` 及 `/mesh/<environmentId>/ws` 的请求，必须先通过网关访问密码登录（Cookie 或 Bearer Token / 网关一次性 WS Ticket）。
   - 代理会自动剥离客户端 Cookie/Authorization 与上游 `Set-Cookie`，且当网关会话被吊销时，正在转发的 WebSocket 连接会立即断开。
3. **过滤代理 TUN / 虚假网卡**：
   - Clash / Mihomo Fake-IP 网段（`198.18.0.0/15`）、Tailscale CGNAT（`100.64.0.0/10`）、Docker/VM 虚拟网桥会自动排除，不会干扰 EasyTier 探测或广播地址。

---

## 一、普通桌面 / Linux 节点配置（零配置自动发现）

### 1. Desktop 桌面端（Windows / macOS / Linux）

1. 在机器上启动 EasyTier，使其获得 EasyTier 虚拟网卡 IP（例如 `10.126.126.10/24`）。
2. 启动 Quixotic Desktop：
   - 桌面端默认开启**网络访问**（如系统无可用网卡会自动回退为仅本机），并优先广播 EasyTier 地址。
   - 打开 **设置 → 共享与访问 → EasyTier 与公网网关**，可查看本机 EasyTier IP、已发现的在线节点列表，或点击 **立即扫描** 手动触发扫描。
   - 打开 **设置 → 环境**，所有在线的 EasyTier 机器会自动出现并连接，无需手动配对。

### 2. 无头 Linux / 服务器节点（CLI）

```bash
quixotic-cli serve --host 0.0.0.0 --port 3773
```

可选环境变量 / 参数：

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--easytier-cidr <cidr>` | `QUIXOTIC_EASYTIER_CIDR` | 手动指定 EasyTier 子网（如 `10.126.126.0/24`），默认自动检测 |
| `--easytier-peers <list>` | `QUIXOTIC_EASYTIER_PEERS` | 额外静态节点列表，逗号分隔（如 `10.126.126.10:3773,10.126.126.20:3773`） |
| `--no-easytier` | `QUIXOTIC_EASYTIER=0` | 禁用本机 EasyTier 自动发现与零配对认证 |
| — | `QUIXOTIC_EASYTIER_PORTS` | 扫描端口列表，逗号分隔，默认包含当前端口与 `3773` |

---

## 二、云服务器公网网关部署（供手机端公网访问）

在一台同时拥有**公网 IP** 和 **EasyTier 虚拟网卡** 的云服务器上部署 Quixotic 网关：

### 1. 命令行直接启动

```bash
QUIXOTIC_GATEWAY_PASSWORD='<YOUR_STRONG_PASSWORD>' \
QUIXOTIC_PUBLIC_GATEWAY_URL='http://203.0.113.10:3773' \
quixotic-cli serve \
  --host 0.0.0.0 \
  --port 3773 \
  --gateway
```

也可以通过命令行参数传入：

```bash
quixotic-cli serve \
  --host 0.0.0.0 \
  --port 3773 \
  --gateway \
  --gateway-password '<YOUR_STRONG_PASSWORD>' \
  --public-gateway-url 'http://203.0.113.10:3773'
```

> 提示：你也可以在启动后打开 Web 端 **设置 → 共享与访问 → EasyTier 与公网网关** 在线设置或修改网关访问密码（至少 6 位，使用 scrypt 哈希保存在服务端密钥存储中）。

### 2. systemd 常驻服务示例

创建 `/etc/systemd/system/quixotic-gateway.service`：

```ini
[Unit]
Description=Quixotic EasyTier Public Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=quixotic
Environment=QUIXOTIC_GATEWAY=1
Environment=QUIXOTIC_GATEWAY_PASSWORD=<YOUR_STRONG_PASSWORD>
Environment=QUIXOTIC_PUBLIC_GATEWAY_URL=http://203.0.113.10:3773
ExecStart=/usr/local/bin/quixotic-cli serve --host 0.0.0.0 --port 3773
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now quixotic-gateway
sudo systemctl status quixotic-gateway
```

### 3. 防火墙与反向代理建议

- **云服务器安全组 / 防火墙**：放行网关端口（如 `TCP 3773` 或 HTTPS `443`）；确保其他内网机器的 `3773` 仅对 EasyTier 虚拟网卡和局域网可达，不要暴露到公网。
- **可选 HTTPS 反代（Caddy 示例）**：如果有域名，建议套一层 HTTPS：

```caddyfile
quixotic.example.com {
    reverse_proxy 127.0.0.1:3773
}
```

> 如果使用反代，请将 `QUIXOTIC_PUBLIC_GATEWAY_URL` 设置为 `https://quixotic.example.com`。反代默认附带 `X-Forwarded-For`，服务端会自动将其识别为外部公网访问并要求网关密码登录。

---

## 三、手机端连接方式

### 方式 A：手机浏览器（Web）

1. 在手机浏览器打开公网网关地址：`http://<PUBLIC_IP>:3773`（或 `https://<YOUR_DOMAIN>`）。
2. 在登录页输入**网关访问密码**完成登录。
3. 登录后，前端会自动拉取网关的 EasyTier 节点列表，并通过 `/mesh/<environmentId>/*` 自动挂载全部在线机器，直接切换环境即可远程操作。

### 方式 B：手机 App（iOS / Android）

1. 打开手机 App，进入 **添加环境**（`+`）。
2. 填写：
   - **地址**：`203.0.113.10:3773`（公网 IP:端口，或 HTTPS 域名）
   - **密码**：云服务器上设置的**网关访问密码**
3. 点击确认连接：
   - App 会验证并连接公网网关；
   - 随后自动发现该网关 EasyTier 子网下所有在线的 Quixotic 机器并添加到环境列表，无需逐台扫码配对。

---

## 四、常见问题排查

1. **本机看不到 EasyTier IP**：
   - 检查虚拟网卡是否已启动（Linux：`ip addr` 查看 `tun0` / `easytier*`；Windows：`ipconfig` 查看 EasyTier 网卡）。
   - 如果虚拟网卡名不在默认识别列表中，可通过 `QUIXOTIC_EASYTIER_CIDR=10.126.126.0/24` 显式指定子网。
2. **其他机器没有自动出现**：
   - 确认目标机器 Quixotic 正在监听 `0.0.0.0`（桌面端需开启「网络访问」），且防火墙允许来自 EasyTier 网段（如 `10.126.126.0/24`）访问 `3773` 端口。
   - 在 **设置 → 共享与访问 → EasyTier 与公网网关** 点击 **立即扫描** 查看实时探测结果。
   - 若某节点使用了非默认端口，可通过 `QUIXOTIC_EASYTIER_PEERS=10.126.126.10:4000` 或 `QUIXOTIC_EASYTIER_PORTS=3773,4000` 补充。
3. **手机通过公网打开后提示需要密码，但输入后报错**：
   - 确认网关服务器已配置 `QUIXOTIC_GATEWAY_PASSWORD` 或已在网关 Web 设置中保存密码（至少 6 位）。
   - 确认网关日志中没有报错，且云安全组已放行对应端口的 HTTP 与 WebSocket 流量。
