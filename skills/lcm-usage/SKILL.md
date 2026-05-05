---
name: lcm-usage
description: How and when to use LCM tools (lcm_grep, lcm_describe, lcm_expand, lcm_expand_query) to retrieve conversation history that was compacted
autoload: true
---

# Lossless Context Management (LCM)

开启 LCM 后，即便经过上下文压缩，你的完整会话历史也会被无损保留。当当前上下文窗口中找不到所需历史信息时，可以使用以下工具进行检索和调取
## When to use LCM tools

- 上下文压缩后，需要获取会话前期的详细内容 
- 用户提及「之前」「前面聊过」的相关内容时 
- 需要核对历史对话中的决策、文件路径、技术方案时 
- 处理跨多个上下文压缩周期的任务时 
- 不确定过往已经讨论过哪些内容、达成过哪些结论时

## 可用工具说明

### `lcm_grep` — 检索会话历史
通过关键词或语句检索所有已存储的会话记录，检索结果会按所属摘要节点分组展示
```
lcm_grep(query: "authentication bug")
lcm_grep(query: "database schema", limit: 10)
lcm_grep(query: "login flow", summary_id: "sum_abc123")
```

### `lcm_describe` — 查看指定条目详情
通过 ID 获取某条摘要（sum_ 开头）或单条消息（msg_ 开头）的元数据与完整内容
```
lcm_describe(id: "sum_abc123")
lcm_describe(id: "msg_xyz789")
```

### `lcm_expand` — 从摘要还原原始会话
将一条会话摘要展开，还原出对应的完整原始消息记录
```
lcm_expand(summary_id: "sum_abc123")
lcm_expand(summary_id: "sum_abc123", depth: 2, token_cap: 4000)
```

### `lcm_expand_query` — 一步完成检索 + 展开
直接检索相关会话历史，并一次性展开返回完整原始消息内容
```
lcm_expand_query(query: "the login flow we discussed")
lcm_expand_query(query: "error handling approach", max_results: 3)
```

## 标准检索工作流程

1. 先用 `lcm_grep` 检索定位目标历史内容 
2. 对匹配到的 ID 使用 `lcm_describe` 查看元数据概览 
3. 再用 `lcm_expand_query` 还原完整原始会话消息 
4. 也可直接使用 `lcm_expand_query` 一次性完成上述1-3全部步骤