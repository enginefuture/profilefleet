# ProfileFleet

ProfileFleet 是一个本地优先的 TypeScript 指纹浏览器控制层，用统一 API
管理持久 profile、独占租约、并发容量、崩溃恢复和 Playwright CDP 连接。
React 组件库和内置控制台复用同一套公开客户端。

> 当前版本：`v0.1.0`。单机多实例、本机客户端、首发 CloakBrowser 适配器。

## 解决什么问题

启动一个浏览器并不难，困难的是长期维护多个一致的浏览器身份：避免两个进程
同时打开同一 profile、避免 CDP 端口冲突、daemon 崩溃后找回仍在运行的
Chromium、回收遗失的任务，以及避免代理密码进入元数据和日志。

ProfileFleet 负责这些生命周期工作；页面自动化仍由 Playwright 完成，具体指纹
能力由可替换的 engine adapter 提供。

## 主要能力

- 固定指纹身份的持久浏览器 profile
- 可续期、可过期、支持幂等获取的独占 lease
- 显式容量限制和空闲自动关闭
- 带 owner token 的 profile 文件锁和 orphan browser 接管
- 默认仅监听本机回环地址的 HTTP API 与 CDP
- 代理密钥只从环境变量解析，不写入配置和日志
- TypeScript client、React hooks/components、管理控制台
- 通用 `BrowserEngineAdapter` 与可测试的 fake adapter

## 安装

npm 正式发布前，可直接安装 GitHub Release 中的 npm 包：

```bash
npm install https://github.com/enginefuture/profilefleet/releases/download/v0.1.0/profilefleet-0.1.0.tgz
npx profilefleet doctor --install
npx profilefleet start --ui
```

打开 daemon 输出的 Console 地址即可。URL fragment 中的本地 bearer token
会被控制台读取后立即从地址栏移除，并只保存在当前标签页的 session storage。

CloakBrowser wrapper 会在首次使用时按上游规则下载并校验浏览器二进制；
ProfileFleet 不会再分发该二进制。新版可能需要 CloakBrowser 的免费或付费 key：

```bash
export CLOAKBROWSER_LICENSE_KEY=cb_xxxxxxxx
```

该值只会传给 CloakBrowser，不会由 ProfileFleet 保存。

## TypeScript 示例

```ts
import { ProfileFleetClient } from "profilefleet/client";
import { connectPlaywright } from "profilefleet/playwright";

const fleet = new ProfileFleetClient({
  baseUrl: "http://127.0.0.1:47110",
  token: process.env.PROFILEFLEET_TOKEN,
});

const profile = await fleet.profiles.create({
  id: "research",
  name: "AI research",
  locale: "zh-CN",
  timezone: "Asia/Shanghai",
  proxyUrlEnv: "PROFILEFLEET_PROXY_RESEARCH",
});

const managed = await fleet.acquireManaged({
  profileId: profile.id,
  owner: "research-worker",
  ttlSeconds: 600,
});

try {
  const browser = await connectPlaywright(managed.lease);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://example.com");
} finally {
  await managed.release();
}
```

## React 示例

```tsx
import {
  FleetOverview,
  ProfileFleetProvider,
  ProfileTable,
  SessionPanel,
} from "profilefleet/react";
import "profilefleet/styles.css";

<ProfileFleetProvider clientOptions={{ baseUrl, token }}>
  <FleetOverview />
  <ProfileTable />
  <SessionPanel />
</ProfileFleetProvider>
```

还提供 `ProfileForm`、`useProfiles`、`useSessions`、`useCapacity`、
`useProfileActions` 和 `useFleetEvents`。

## 默认配置

数据目录为 `~/.profilefleet`：

```text
~/.profilefleet/
├── config.json
├── token
└── profiles/<profile-id>/
    ├── profile.json
    ├── .session.lock
    └── user-data/
```

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PROFILEFLEET_HOME` | `~/.profilefleet` | 数据根目录 |
| `PROFILEFLEET_PORT` | `47110` | 管理 API 端口 |
| `PROFILEFLEET_MAX_CONCURRENT` | `1` | 最大活跃/orphan session 数 |
| `PROFILEFLEET_IDLE_TIMEOUT_MS` | `60000` | 无 lease 后的关闭延时 |
| `PROFILEFLEET_TOKEN` | 自动生成 | 覆盖本地 bearer token |
| `CLOAKBROWSER_LICENSE_KEY` | 未设置 | 直接传给 CloakBrowser |

profile 仅记录类似 `PROFILEFLEET_PROXY_RESEARCH` 的环境变量名；代理 URL、
用户名和密码不会写入 profile JSON、HTTP 响应或日志。

首次成功启动后，engine、fingerprint seed、locale、timezone 和 proxy 引用
视为固定身份字段。需要改变它们时应创建新 profile；原 profile 只允许修改名称和 tags。

## 安全边界

- v0.1 的 daemon 和 CDP 只绑定 `127.0.0.1`。
- 除 `/v1/health` 外，所有管理 API 都要求 bearer token。
- 默认拒绝跨域浏览器请求。
- 跨机器使用时请建立 SSH tunnel，不要把 daemon 或 CDP 暴露到公网。
- 项目只面向授权账号、QA、测试和会话隔离，不提供验证码绕过、撞库、批量注册、
  站点专用规避或未经许可的自动化。

参见 [架构说明](docs/ARCHITECTURE.md)、[安全策略](SECURITY.md)、
[可接受使用政策](ACCEPTABLE_USE.md) 和[第三方声明](THIRD_PARTY_NOTICES.md)。

## 开发

```bash
pnpm install
pnpm check
pnpm dev:console
```

许可证：Apache-2.0。CloakBrowser 编译二进制采用独立条款，且不会包含在本项目中。
