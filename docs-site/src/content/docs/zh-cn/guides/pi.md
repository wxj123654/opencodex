---
title: Pi
description: 在 Pi 中使用任意已路由模型 - `ocx export` 会为 Pi 的 `models.json` 写入一个自定义 provider 块，并连接到正在运行的代理。
---

Pi 从一个全局 JSON 文件而不是环境变量中读取 providers，所以 opencodex 不会启动它。相反，`ocx export` 会序列化 `opencodex` provider 块 - 基础 URL、模型列表，以及 Pi 会插值的 env 引用 - 然后你把它合并到自己的配置中。

## 快速开始

先启动代理，再打印配置：

```bash
ocx start
ocx export --client pi
```

输出会先显示 JSON，然后打印目标路径、合并警告、env 导出行，以及有多少模型带有权威上下文窗口限制。

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "$OPENCODEX_API_KEY",
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

模型 id 是代理的规范选择器，因此已路由模型会显示为 `provider/model`（`anthropic/claude-opus-5`），而原生 OpenAI slug 会保持不带前缀（`gpt-5.6-sol`）。`name` 后缀 - `(anthropic)`、`(native)`、`(routed)` - 负责让两个同名但来自不同上游的模型在 Pi 的选择器中可区分。

## 放置位置

Pi 的全局模型配置位于：

```text
~/.pi/agent/models.json
```

:::caution[只合并，不要替换]
`ocx export` 永远不会写入那个文件。请把 `providers.opencodex` 块合并进去 - 直接替换整个文件会破坏你已配置的其他 provider。`--out` 只用于临时路径，并且如果不加 `--force` 就不会覆盖已有文件：

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # or redirect the byte-exact JSON
```
:::

导出的块是静态快照，不是实时视图。新增 provider 或更改模型可见性后，请重新运行 `ocx export`，再用新的块覆盖旧块进行合并。

## 或者让 opencodex 接管这个块

手动合并并不是唯一的路径。opencodex 可以接管该文件中的 `providers.opencodex` 块：由它替你写入——思考等级也包含在内，以 `reasoning: true` 加上一个把 Pi 的档位选择限制在每个模型真实阶梯上的 `thinkingLevelMap` 呈现——并且不碰文件里的其他 provider。

```bash
ocx integration client enable --client pi                          # 接管并写入该块
ocx integration client enable --client pi --overwrite-conflict     # 强制替换已漂移的块
ocx integration client status --client pi                          # current / stale / not installed
ocx integration client history --client pi                         # 每次写入记录（带 op id）
ocx integration client restore --op <opId>                         # 回滚某次写入
ocx integration client disable --client pi                         # 解除接管（块保留）
```

如果现有块被手动编辑过、与 opencodex 要写入的内容不一致，`enable` 会拒绝；
`--overwrite-conflict` 就是强制用当前 catalog 内容替换它的出口。注意：受管的 Pi 块**不会**被
`ocx sync` 自动刷新（目前只有 MiniMax Code 会自动刷新）。模型、思考阶梯或可见性变更后，
请重新运行 `enable --overwrite-conflict`——或使用仪表盘 Integrations 页面的 Refresh /
Replace 操作——把块更新到最新。`status` 报告 `stale` 就是需要这么做的信号。完整的语义、
快照与回滚规则见[集成指南](/guides/integrations/)。

## 接入密钥

## 准入密钥

这里有两个很容易混淆的 key，但这个文件里只会出现第一个：

| Key | 它是什么 | 它存放在哪里 |
| --- | --- | --- |
| 代理准入密钥 | opencodex 自己的凭据，在仪表盘的 **API** 选项卡中生成 | 通过 `apiKey` 以 `$OPENCODEX_API_KEY` 形式引用；实际值保存在你的环境中 |
| Provider key | 你的 Anthropic / OpenAI / OpenRouter key | opencodex 自己的配置中，见 [Providers](/guides/providers/) |

导出的配置只包含引用，从不包含 secret。Pi 会插值裸的 `$NAME`，所以变量是：

```bash
export OPENCODEX_API_KEY=<your key>
```

这个名字只属于 Pi。opencode 使用不同的变量（`OPENCODEX_OPENCODE_API_KEY`，以 `{env:…}` 形式出现） - 见 [opencode 指南](/guides/opencode/)。

**回环代理根本不需要 key。** opencodex 默认绑定 `127.0.0.1`，在那里不做任何认证，所以 `$OPENCODEX_API_KEY` 引用是无效的，你可以不设置这个变量。它只在 `hostname` 超出回环范围时才有意义，而这也是代理会在没有 token 的情况下拒绝启动的时候 - 见 [远程访问](/reference/configuration/#remote-access)。

## 模型元数据

只有当目录报告了权威的上下文窗口时，`contextWindow` 和 `maxTokens` 才会被输出。如果没有报告，这两个字段就会在该模型上省略，Pi 会应用自己的默认值；`ocx export` 会打印有多少行落入了这种情况。

`maxTokens` 是一个满足 schema 的 `32000` 预算，并会向下钳制到上下文窗口，因此不会给小上下文模型分配超过其上下文容量的输出。它并不声称某个具体模型的真实最大值。

`cost` 在每一行都写成显式的零。两个原因，各占一边：pi 的 models.json 加载器并不会应用文档所述的全零默认值，而它的用量计算器在每条 assistant 消息上都会读取 `model.cost.tiers` —— 缺少 `cost` 的行会让会话直接崩溃，报 `Cannot read properties of undefined (reading 'tiers')`。同时，opencodex 没有已路由模型的价格数据，所以零也是诚实的值：客户端的估算保持 $0，真正的记账由代理完成。如果你是手动合并导出块，请保留 `cost` 字段 —— 不要删除它。`reasoning` 在 Pi 里是一个布尔值，而目录里是一个 effort 层级，把二者互相映射只能是猜测。

## Schema 状态

:::note[未在真实安装上验证]
上面的结构遵循了 Pi 已公开的自定义 provider 文档。它**尚未**在一台安装了 Pi 的机器上、针对真实的 `~/.pi/agent/models.json` 进行验证。如果 Pi 拒绝这个导出块，问题在我们这边 - 请带上 Pi 的报错信息[提交 issue](https://github.com/lidge-jun/opencodex/issues)。
:::

## 需求

需要一个正在运行的 opencodex 代理（`ocx start`）以及已安装的 Pi。`ocx export` 通过代理的 management API 读取实时目录，因此配置永远不会在模型列表为空时被导出。
