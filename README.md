# magpie-kilo2api-auth

**把 Kilo Gateway 的免费模型接进 [magpie](https://github.com/yetone/magpie)。**

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-green)
![magpie](https://img.shields.io/badge/magpie-%E2%89%A5%200.1.1083-blueviolet)

---

## 这是什么

[Kilo Gateway](https://api.kilo.ai/api/gateway) 是 Kilo Code 背后的模型网关，OpenAI 兼容，上面有一批**标价为零的免费模型**（`kilo-auto/free`、若干 `:free` 结尾的模型）。匿名就能调用，不需要账号、不需要 API Key。

问题是它只能给 Kilo 自己的客户端用。这个 magpie 插件把同一批模型接进 magpie 的本地网关，于是 Claude Code、Codex、OpenCode、Cursor、Cline 等任何 agent 都能把它们当成普通模型来用，并且享受 magpie 的账号切换、故障转移、用量统计。

**它只做一件事**：把 Kilo 的免费模型，变成 magpie 的一个供应商。

### 与其他 Kilo 插件的关系

| 插件 | 做什么 | 是否冲突 |
|---|---|---|
| `@magpie-community/agent-kilo` | 让 magpie **管理** Kilo Code 这个 agent 的模型配置 | 不冲突 |
| [lesnolie/magpie-free-gateways](https://github.com/lesnolie/magpie-free-gateways) | 同类插件，同时支持 Zen 与 Kilo | 功能重叠，二选一 |
| **本插件** | 把 Kilo Gateway 作为 **provider** 接进 magpie | — |

---

## 特性

- **零配置**：匿名登录，确认一下就能用，不需要注册 Kilo 账号
- **实时模型目录**：模型列表来自 Kilo 的 `/models`，以 `isFree` 字段为准，上游增删自动跟随，插件不需要发新版本
- **四种登录方式**：匿名 / 浏览器设备码 / 桌面端导入 / API Key
- **多账号**：可以登录多个 Kilo 账号，各自独立计额度，由 magpie 统一调度与故障转移
- **免费白名单**：请求非免费模型时返回 `404`，而不是把整个账号标记为失效
- **离线可用**：内置 14 个免费模型的快照，断网或上游不可达时仍能列出模型
- **无运行时依赖**：不用任何 npm 包，只用 Node/Bun 自带的 `fetch`

---

## 快速开始

### 1. 安装

从 GitHub 直接装：

```bash
magpie plugin add github:cv-superding/magpie-kilo2api-auth
```

或者克隆到本地、以文件夹形式加载（改代码后立即生效）：

```bash
git clone https://github.com/cv-superding/magpie-kilo2api-auth.git
magpie plugin add ./magpie-kilo2api-auth
```

### 2. 登录

```bash
magpie plugin login kilo-free
```

会看到四个选项：

```
How do you sign in to Kilo Gateway Free?
  1. 匿名免费访问（无需账号，确认即可）
  2. 浏览器登录 Kilo 账号（设备码，可重复添加多个账号）
  3. 从 Kilo 桌面端 / CLI 导入（读本机登录）
  4. Kilo API Key（可选，提升限额）
```

**只想白嫖免费模型，选 1 就行。**

### 3. 确认

```bash
magpie plugin                    # 查看登录状态与模型数
magpie provider test kilo-free   # 真实发一次请求，验证整条链路
```

正常会看到：

```
kilo-free (Kilo Gateway Free, 14 models)  signed in
✓ chat       1053 ms · kilo-auto/free
```

### 4. 使用

模型在 magpie 里以 `kilo-free/<模型 id>` 的形式出现。因为 Kilo 的模型 id 本身带斜杠，完整写法是：

```
kilo-free/kilo-auto/free
kilo-free/nvidia/nemotron-3.5-lightning:free
```

在 agent 里直接选即可（magpie 的 Agents 页面），或者通过 magpie 的 OpenAI 兼容端点调用：

```bash
curl http://127.0.0.1:3425/v1/chat/completions \
  -H "Authorization: Bearer <你的 magpie key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kilo-free/nvidia/nemotron-3.5-lightning:free",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

magpie 会负责协议转换，所以即使 agent 说的是 Anthropic Messages 或 OpenAI Responses，也会被转成 Kilo 需要的 chat completions。

---

## 登录方式详解

### 方式一：匿名（推荐给只想白嫖的人）

Kilo 的免费模型对匿名流量开放，额度按 **IP** 计（约 200 请求/小时）。

插件在匿名模式下**完全不发 `Authorization` 头**。这一点是刻意的：Kilo 网关会把任何 `Authorization` 头当成真实凭据去校验，随便填个占位符（比如 `Bearer public`）反而会 401。

### 方式二：浏览器设备码

走 Kilo CLI 自己用的设备授权流程，适合没装 Kilo 桌面端的人。

1. 插件向 `POST https://api.kilo.ai/api/device-auth/codes` 申请一个设备码
2. magpie 会打开 `https://app.kilo.ai/device-auth?code=XXXX-XXXX`
3. 你在浏览器里确认后，插件轮询拿到 token

**可以重复登录多个不同账号**，每个都会成为 magpie 里的一条独立账号记录。

### 方式三：从 Kilo 桌面端 / CLI 导入

Kilo Desktop、VS Code 扩展、CLI 共用一份登录状态：

```
~/.local/share/kilo/auth.json
```

插件读这份文件，把里面的 `access` / `refresh` / `expires` 拿来用。**只读不写**，不会影响 Kilo 本身。

导入之后，插件**每个请求都会重新读一次**这个文件——所以在 Kilo 里换账号、重新登录、退出，插件会自动跟着变，不需要重新导入。

探测顺序（命中即止）：

1. `$KILO_AUTH_CONTENT`（Kilo 官方的覆盖机制）
2. `$XDG_DATA_HOME/kilo/auth.json`
3. `~/.local/share/kilo/auth.json`
4. `$XDG_CONFIG_HOME/kilo/auth.json`
5. `~/.config/kilo/auth.json`
6. `%LOCALAPPDATA%\kilo\auth.json`
7. `%APPDATA%\kilo\auth.json`

账号显示名取自 `https://api.kilo.ai/api/profile` 的邮箱，所以你会看到 `signed in as you@example.com` 而不是一串 UUID。

### 方式四：API Key

在 [app.kilo.ai](https://app.kilo.ai) 生成。适合想用自己账号、或者要接入组织额度的场景。

---

## 免费模型

以下是插件内置快照里的 14 个模型（2026-11-14 取自上游）。**实际列表由上游实时决定**，以 `magpie provider models kilo-free` 为准。

全部 14 个都支持 **工具调用（tools）** 和 **推理（reasoning）**。

| 模型 id | 上下文 | 最大输出 | 输入模态 | 推理档位 |
|---|---|---|---|---|
| `kilo-auto/free` | 256K | 32K | 文本 | — |
| `nvidia/nemotron-3.5-super-vl:free` | 1M | 131K | 文本 / 图片 / 视频 | — |
| `stealth/glyph-cluster` | 256K | 256K | 文本 | — |
| `inclusionai/ling-3.2-flash:free` | 1M | 262K | 文本 / 图片 | — |
| `baidu/ernie-5.5-flash-preview:free` | 1M | 921K | 文本 | low / medium / high |
| `liquid/lfm-3-1.7b:free` | 256K | 8K | 文本 | — |
| `particle-ai/particle-1:free` | 1M | 131K | 文本 / 图片 | low / medium / high |
| `dots-studio/dots-3-note-preview:free` | 512K | 460K | 文本 / 图片 | — |
| `nvidia/nemotron-3.5-lightning:free` | 1M | 65K | 文本 | — |
| `cohere/north-mini-code:free` | 256K | 64K | 文本 | — |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1M | 65K | 文本 | low / medium / high |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256K | 65K | 文本 / 音频 / 图片 / 视频 | — |
| `openrouter/free` | 200K | 未知 | 文本 / 图片 | low / medium / high |
| `reflection/beam-free` | 1M | 131K | 文本 | — |

`kilo-auto/free` 是 Kilo 自己的路由器，会在可用免费模型之间自动挑一个，最省心。

---

## 多账号

免费额度会限流，多备几个账号能提高可用性。magpie 原生支持一个插件下的多个账号。

**登录第二个账号**：再执行一次 `magpie plugin login kilo-free`，选方式 2（浏览器设备码）或方式 3（桌面端导入，前提是桌面端此时登的是另一个账号）。

每个账号会以独立条目存储在 `~/.config/magpie/plugin-auth.json`：

```
kilo-free              → accountId: you@example.com
kilo-free#abc123       → accountId: another@example.com
```

查看全部账号：

```bash
magpie plugin --json
```

> **注意**：magpie 只把 **oauth 类型**、且带 `accountId` 的凭据当作独立账号。所以本插件的「桌面端导入」也是按 oauth 形状保存的，而不是简单的 API Key。这也是为什么导入后会显示邮箱——那是账号的区分标识。

---

## 限流与配额：需要知道的真相

这一节比较重要，因为它决定了你该怎么用。

### 额度是按 IP 算的，不是按账号

匿名访问的额度约为 **200 请求/小时 per IP**。也就是说，同一台机器上登再多的匿名账号，用的还是同一个池子。想靠"多开几个号"绕过这个限制是没用的。

### 真正卡人的是模型级 429

你会遇到的 `429` 大多来自上游的共享池（OpenRouter），而且它是**模型级**的——错误里会点名具体是哪个模型。实测同一时刻，某个模型 429 了，其他免费模型照常 `200`。

所以**正确的解法是换模型，不是换账号**。

### 建议：把免费模型组成路由组

与其死磕一个模型，不如让 magpie 在它失败时自动换下一个：

```bash
magpie group add "kilo free" models='kilo-free/*' routing=order
```

- `models='kilo-free/*'` 是 glob，把这个供应商下所有模型都收进来，以后上游新增免费模型会自动包含，不用改配置
- `routing=order` 固定用第一个，它答不了（429 / 503）才切下一个。对编程 agent 来说这比频繁换模型更稳定
- 想主动分摊，可以换成 `routing=rotate`（每条消息轮到下一个成员）或 `routing=smart`（按剩余额度与续期时间挑）
- 加上 `stays=session` 可以让同一段对话固定在一个成员上，避免中途换模型导致行为不一致

组建好后，agent 里选 `group/kilo-free` 即可，超限时 magpie 自动切到组内下一个，agent 看不到报错。

### 插件报的额度信息是空的

`magpie quota` 不会列出这个供应商的额度窗口，应用内对应位置会显示「暂无额度数据」。这是**正常现象**——Kilo 没有公开的余额/配额查询接口，插件不会编造假数据。真实消耗请看 [app.kilo.ai](https://app.kilo.ai) 或 magpie 的 Usage 页面（本地统计的 token 用量是准的）。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **只有免费模型** | 插件是免费模型专用。付费模型不会出现在列表里，也不会被放行 |
| **付费模型会失败** | 匿名调用付费模型上游返回 `401 PAID_MODEL_AUTH_REQUIRED`，登录但没余额返回 `402 Credits Required`。插件把前者的语义改写成"模型不可用"，见下节 |
| **仅 chat completions** | 插件只代理 `/chat/completions`。其他协议由 magpie 转换，不需要插件操心 |
| **不会自动续期** | Kilo 的 refresh 端点没有公开（`/api/gateway/auth/refresh` 会被当成模型路径拒掉）。好在 access token 有效期约 1 年，过期后重新登录一次即可 |
| **模型可能记录你的 prompt** | 上游对所有 14 个免费模型都标了 `mayTrainOnYourPrompts: true`。**不要用它处理敏感数据** |
| **依赖未公开接口** | 设备码与模型列表都是 Kilo 的内部接口，随时可能变更。变更时插件会失效，需要跟进修复 |

---

## 工作原理

插件遵循 magpie 的 [OpenCode v1 插件协议](https://usemagpie.ai/docs/plugins)，只用四个钩子。

```
agent → magpie 网关 :3425
          ↓ 协议转换（Anthropic / Responses → chat.completions）
        插件 fetch()  ← 白名单校验、错误语义改写
          ↓
    https://api.kilo.ai/api/gateway/chat/completions
```

### 关键设计决策

**1. 用 `isFree` 而不是价格判断免费**

上游共有 473 个模型，其中 `pricing.prompt == "0"` 的有 17 个，但 `isFree === true` 的只有 14 个。差的 3 个（`google/lyria-3-pro-preview` 等）是音乐生成类模型，标价为零但根本不能在 `/chat/completions` 上工作。只看价格会把它们列出来，用户选中后必然失败。

**2. 匿名不发 `Authorization` 头**

Kilo 会校验任何 `Authorization` 头。`Bearer public` 这类占位符会 401，所以匿名模式干脆不发。

**3. 把 `401` 改写成 `403`**

这是最重要的一处。magpie 的语义里，`401` 意味着"这个账号要重新登录"，会把它标记为失效；而 `403/404` 只意味着"这个模型不可用"，会换个模型继续。

Kilo 对匿名访问付费模型返回的恰恰是个 `401`，消息还是 *"You need to sign in to use this model"*——照实透传，用户误选一次付费模型，整个渠道就被标记为失效了。所以插件会识别 `PAID_MODEL_AUTH_REQUIRED` 并改写成 `403` + `X-Magpie-Sign-In: kept`，保留 Kilo 的原文。

**4. 请求体原样转发**

解析 body 只为读 `model` 做白名单校验，实际发送的是**未经重新序列化的原始字符串**。重新 `JSON.stringify` 会改变字节，进而破坏 prompt 缓存的前缀匹配，白烧 token。

**5. 目录 5 分钟 TTL + 失败降级**

每次请求都读一遍上游列表会被 IP 限流反噬。插件缓存 5 分钟；读取失败时保留上一次的列表，并打上 `Symbol.for("magpie.fellBack")` 标记，让 magpie 不要因为一次网络抖动就把用户已选的模型删掉。

**6. 未知模型返回 `404` 而不是抛异常**

抛异常会让整个请求失败；返回 404 只会让 magpie 禁用这一个模型，其他模型继续可用。

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `not signed in` | 还没登录。`magpie plugin login kilo-free` |
| `404 model_not_found` | 该模型已不在 Kilo 的免费列表里。`magpie provider models kilo-free` 看当前列表 |
| `503 catalog_unavailable` | 拉不到上游模型列表（网络/代理问题）。检查代理，或稍后重试 |
| `401 authentication_error` | 「桌面端导入」模式下，本机 Kilo 已经登出。重新在 Kilo 登录，或换用其他登录方式 |
| `402` / 提示 Credits Required | 该账号没有余额，且该模型是付费模型。这个插件只放行免费模型 |
| 一直 `429` | 撞上 IP 限流或模型级限流。换模型，或按上文配置路由组 |
| 明明登录了却没模型 | `magpie plugin` 确认模型数；必要时重启 magpie 宿主（文件夹插件在 app 内需关掉再打开） |

调试用命令：

```bash
magpie plugin --json              # 插件、账号、模型全量信息
magpie provider models kilo-free  # 当前实时模型列表
magpie provider test kilo-free    # 每个模型各发一个小请求
magpie quota                      # 额度（本插件为空属正常）
```

### 代理

magpie 会自动把 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 传给插件宿主，所以只要 magpie 本身能出网，插件就能出网。实测日志里会打印：

```
plugin: host starts with HTTPS_PROXY=http://127.0.0.1:7897 ...
```

如果上游不可达，先确认这个环境变量是否生效。

---

## 开发

```bash
git clone https://github.com/cv-superding/magpie-kilo2api-auth.git
cd magpie-kilo2api-auth
node --test          # 44 个测试，全部离线，用 mock 上游
magpie plugin add ./ # 以文件夹形式加载，改代码后重启宿主即生效
```

### 目录结构

```
index.mjs          # 入口：export default { id, server }
src/provider.mjs   # 插件主体：config / auth / fetch / provider.models
src/catalog.mjs    # 免费模型筛选、Model 对象构建、TTL 缓存
src/device.mjs     # 设备码授权流程
src/local.mjs      # 读取本机 Kilo 登录信息（只读）
src/snapshot.json  # 离线模型快照
test/              # node:test，无第三方依赖
```

### 更新模型快照

上游模型变动时，快照可以重新生成：

```bash
curl -s https://api.kilo.ai/api/gateway/models \
  | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const free=JSON.parse(s).data.filter(m=>m.isFree===true).map(m=>({
        id:m.id,name:m.name,
        context:m.context_length??m.top_provider?.context_length??0,
        output:m.top_provider?.max_completion_tokens??0,
        input:m.architecture?.input_modalities??['text'],
        parameters:m.supported_parameters??[],
        mayTrain:m.mayTrainOnYourPrompts===true,
      }));
      console.log(JSON.stringify({generated:new Date().toISOString().slice(0,10),models:free},null,2));
    })"
```

不更新也不影响使用——快照只是首启动和离线时的兜底，实际列表永远以实时接口为准。

---

## 免责声明

本项目**非 Kilo 官方项目**，与 Kilo 无任何关联。

它依赖 Kilo Gateway 的未公开接口与免费额度策略，这些随时可能变更，可能导致插件失效。免费模型由 Kilo 及其上游供应商提供，其可用性、额度、数据处理策略（**包括记录并用于训练你的 prompt**）均不在本项目控制范围内。

请自行确认你的使用方式符合 [Kilo 的服务条款](https://kilo.ai/terms)，并**不要在免费模型上处理任何敏感数据、密钥或个人信息**。

仅供学习与研究使用。

---

## 许可证

[MIT](LICENSE) © 2026 cv-superding
