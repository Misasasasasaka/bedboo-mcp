# bedboo-mcp

启动后用独立玩家账号自动加入基岩版多人服务器。内置 agent 调用配置的模型 API，根据任务读取世界、移动玩家和执行 Minecraft 指令，并依据游戏回执继续操作。

## 安装

需要 Git、Node.js 24 或更新版本和 Corepack。仓库里的安装脚本会检出固定版本的 bedboo，把桥接服务装进它的 pnpm 工作区，并使用保留上游补丁的锁文件。[bedboo 工作区教程](https://levimc.org/tutorials/automate/first-bedboo-bot/)

```sh
git clone https://github.com/Misasasasasaka/bedboo-mcp.git
cd bedboo-mcp
node scripts/setup.mjs
```

复制 `.env.example` 为 `.env`，填入游戏连接参数和 `OPENAI_API_KEY`。源码在 `packages/bedboo-mcp/`，`.bedboo/` 是安装脚本生成的工作区。

| 配置 | 用途 |
|---|---|
| `MC_HOST`、`MC_PORT` | Bedrock Dedicated Server 的地址和端口 |
| `MC_VERSION`、`MC_TRANSPORT` | 服务端版本及 `nethernet` 或 `raknet` |
| `MC_ACCOUNT`、`MC_AUTH` | 微软账号和 `microsoft` 认证。首次登录跟随 stderr 输出的设备码提示。独立的本地测试服可用 `offline` 和一个游戏名。 |
| `MC_DATA_DIR` | 登录缓存与执行记录目录，默认为仓库内的 `.bedboo-mcp/` |
| `OPENAI_API_KEY`、`OPENAI_MODEL` | 模型 API 的密钥与模型 ID，示例模型为 `gpt-5.4-mini`。 |
| `OPENAI_BASE_URL`、`OPENAI_API_MODE` | 可选的 OpenAI 兼容 API 基址。默认 `responses`，使用 Chat Completions 的服务设为 `chat`。 |
| `AGENT_COMMANDERS` | 允许在游戏内下达任务的玩家游戏名。多个名字用逗号分隔。 |
| `AGENT_GOAL` | 可选任务，在程序第一次成功入服时执行一次。 |
| `AGENT_MAX_ROUNDS` | 单个任务可调用模型的轮数，默认 24。 |
| `MCP_TRANSPORT`、`MCP_PORT` | 配置模型密钥后默认 `off`，仅使用 MCP 时默认 `stdio`。选 `http` 时监听 `127.0.0.1`，默认端口 `3107`。 |
| `MCP_HTTP_TOKEN` | 可选的 HTTP Bearer 令牌，客户端启用时需发送相同令牌。 |

服务器处于白名单模式时，把机器人账号加入白名单。机器人以自身权限执行命令。原生基岩服上的 `/setblock`、`/fill` 和 `/playsound` 需要开启作弊并授予相应游戏内权限。[bedboo 连接和权限说明](https://levimc.org/bedboo/guide/connecting)

## 启动内置 Agent

```sh
node scripts/start.mjs
```

看到“已入服”后，在终端直接输入任务并回车。也可以将自己的 Minecraft 游戏名填入 `AGENT_COMMANDERS`，然后在游戏聊天里发任务。

> !bot 走到我身边，读一下脚下是什么方块

> !bot 在我旁边找一块平地，在那里盖一栋带玻璃窗的木屋

Agent 根据游戏状态和指令权限决定操作，完成后会在终端输出结果，或私聊游戏内的任务发起人。在终端输入 `stop` 或在游戏内发 `!bot stop`，可以停止模型任务和余下的游戏操作。若希望启动后自动开始，提前在 `AGENT_GOAL` 写入任务。

## 可选的外部 MCP 接入

本机客户端将 `MCP_TRANSPORT` 设为 `stdio`。把以下命令和脚本绝对路径填进 agent 的 MCP 配置。

```json
{
  "mcpServers": {
    "minecraft-bedrock": {
      "command": "node",
      "args": ["/absolute/path/to/bedboo-mcp/scripts/start.mjs"]
    }
  }
}
```

若希望服务独立常驻，在 `.env` 中设置 `MCP_TRANSPORT=http`，然后运行 `node scripts/start.mjs`。本机客户端连接 `http://127.0.0.1:3107/mcp`。ChatGPT 网页端可用 Secure MCP Tunnel 将已配置的私有端点接入为自定义 MCP 服务。[OpenAI 接入说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## 工具

| 工具 | 用途 |
|---|---|
| `get_status` | 游戏连接、坐标和维度。可通过 `include` 查看玩家、背包或附近实体。 |
| `get_blocks` | 读取当前维度中指定整数坐标的方块 ID 和状态。未收到的区块标为 `unknown`，越出维度高度标为 `out_of_bounds`。 |
| `scan_area` | 分页读取包含两个角点的长方体。使用相同范围和返回的 `nextCursor` 读取下一页。 |
| `move_to` | 向当前维度的坐标寻路。可以只提供 X、Z。返回任务 ID。 |
| `run_command` | 执行服务端允许的一条游戏指令。返回任务和命令回执。队列较忙时可按返回的任务 ID 查询。 |
| `run_commands` | 执行有序命令批次。也可为每步提供相对任务启动时刻的 `atMs`。 |
| `get_job`、`cancel_job` | 查询或停止任务。执行记录包括每步的回执和派发时间。 |

让 agent 在游戏里播放声音时，单条工具输入可以这样写。

```json
{
  "command": "/playsound note.harp @a[r=16] ~ ~ ~ 1 1",
  "requestId": "play-nearby-once"
}
```

Agent 需要根据结果调整下一步时，逐次调用 `run_command` 并读取 `steps[0].receipt`。已经安排好的命令可以交给 `run_commands`。省略全部 `atMs` 时，服务逐条等待回执并在首个失败处停止。给每步提供非递减的 `atMs` 时，服务按时间派发，相同偏移按输入顺序派发。计时记录的是向 bedboo 提交指令的时间，实际游戏效果取决于网络和服务器刻。

命令的 `requestId` 可用于重试去重。使用同一个 ID 和同样参数会返回先前的记录。回执丢失时对应步骤标为 `unknown`。重启会保留中断任务的记录，agent 可以读取游戏状态后决定下一步。

## 验证

```sh
node scripts/setup.mjs --test
```

基岩版联调脚本会连接指定端口上的独立本地测试服，执行移动、读写方块和声音指令。测试服需开启作弊，提供 OP 权限并允许离线测试玩家加入。

```sh
BEDBOO_TEST_PORT=19178 BEDBOO_TEST_TRANSPORT=raknet node .bedboo/packages/bedboo-mcp/test/bds-smoke.mjs
BEDBOO_TEST_PORT=19178 BEDBOO_TEST_TRANSPORT=raknet node .bedboo/packages/bedboo-mcp/test/agent-smoke.mjs
```

联调使用 BDS `1.26.63.1` 和 RakNet。stdio 与 HTTP 均验证了玩家入服、区块及方块读取、寻路、`/setblock` 后回读、非法命令反馈、定时 `/playsound` 回执，以及关闭命令反馈后的执行结果。可按测试服配置设置 `BEDBOO_TEST_VERSION` 和 `BEDBOO_TEST_TRANSPORT`。

内置 agent 的联调使用本地模拟模型 API 和实际基岩测试服，覆盖 Responses API 的启动任务、Chat Completions 的游戏聊天任务，以及读方块、执行指令并再次回读的多轮流程。
