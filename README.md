# bedboo-mcp

把基岩版多人服务器接给任意支持 MCP 的 agent。服务通过 bedboo 维持一个独立玩家连接。Agent 读游戏状态、选择并发送 Minecraft 指令，再根据服务器回执继续操作。任务和文件交给 agent 自己处理。

## 安装

需要 Git、Node.js 24 或更新版本和 Corepack。仓库里的安装脚本会检出固定版本的 bedboo，把桥接服务装进它的 pnpm 工作区，并使用保留上游补丁的锁文件。[bedboo 工作区教程](https://levimc.org/tutorials/automate/first-bedboo-bot/)

```sh
git clone https://github.com/Misasasasasaka/bedboo-mcp.git
cd bedboo-mcp
node scripts/setup.mjs
```

复制 `.env.example` 为 `.env`，按目标服填写连接参数。源码在 `packages/bedboo-mcp/`，`.bedboo/` 是安装脚本生成的工作区。

| 配置 | 用途 |
|---|---|
| `MC_HOST`、`MC_PORT` | Bedrock Dedicated Server 的地址和端口 |
| `MC_VERSION`、`MC_TRANSPORT` | 服务端版本及 `nethernet` 或 `raknet` |
| `MC_ACCOUNT`、`MC_AUTH` | 微软账号和 `microsoft` 认证。首次登录跟随 stderr 输出的设备码提示。独立的本地测试服可用 `offline` 和一个游戏名。 |
| `MC_DATA_DIR` | 登录缓存与执行记录目录，默认为仓库内的 `.bedboo-mcp/` |
| `MCP_TRANSPORT`、`MCP_PORT` | 默认使用 `stdio`。选 `http` 时监听 `127.0.0.1`，端口默认 `3107`。 |
| `MCP_HTTP_TOKEN` | 可选的 HTTP Bearer 令牌，客户端启用时需发送相同令牌。 |

服务器处于白名单模式时，把机器人账号加入白名单。机器人以自身权限执行命令。原生基岩服上的 `/setblock`、`/fill` 和 `/playsound` 需要开启作弊并授予相应游戏内权限。[bedboo 连接和权限说明](https://levimc.org/bedboo/guide/connecting)

## 接入 Agent

本机客户端使用 stdio。把以下命令和脚本绝对路径填进 agent 的 MCP 配置。

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
```

首次联调使用 BDS `1.26.63.1` 和 RakNet。stdio 与 HTTP 均验证了玩家入服、区块及方块读取、寻路、`/setblock` 后回读、非法命令反馈、定时 `/playsound` 回执，以及关闭命令反馈后的执行结果。测试脚本默认匹配 `1.26.63.1` 的 NetherNet 配置，可用 `BEDBOO_TEST_VERSION`、`BEDBOO_TEST_TRANSPORT` 覆盖。
