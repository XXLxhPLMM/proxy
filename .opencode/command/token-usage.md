---
description: 统计 Token 消耗：Sessions、消息数、Token 用量、缓存命中率、费用。支持指定时间范围，默认今日。
subtask: true
agent: explore
---

请统计指定时间范围内的 Token 消耗情况，严格按以下步骤执行：

## 1. 确定时间范围

根据用户输入判断时间范围：
- **用户未指定时间**：统计今日数据
- **用户指定时间**：按用户指定的时间范围统计
  - 支持格式：`昨天`、`最近7天`、`最近30天`、`2026-08-01 到 2026-08-25` 等
  - 将自然语言转换为 Unix 时间戳（毫秒）

## 2. 查询总览数据

运行以下 SQL 获取总览：

```sql
SELECT 
  COUNT(DISTINCT id) as total_sessions,
  ROUND(SUM(tokens_input) / 1000000.0, 2) as input_M,
  ROUND(SUM(tokens_output) / 1000000.0, 2) as output_M,
  ROUND(SUM(tokens_reasoning) / 1000000.0, 2) as reasoning_M,
  ROUND(SUM(tokens_cache_read) / 1000000.0, 2) as cache_read_M,
  ROUND(SUM(tokens_cache_write) / 1000000.0, 2) as cache_write_M,
  ROUND(SUM(tokens_input + tokens_output + tokens_reasoning + tokens_cache_read) / 1000000.0, 2) as total_tokens_M,
  ROUND(SUM(cost), 4) as total_cost,
  CASE 
    WHEN SUM(tokens_input) + SUM(tokens_cache_read) > 0 
    THEN ROUND(SUM(tokens_cache_read) * 100.0 / (SUM(tokens_input) + SUM(tokens_cache_read)), 2)
    ELSE 0 
  END as cache_hit_rate
FROM session 
WHERE time_created/1000 >= {start_timestamp}
AND time_created/1000 < {end_timestamp};
```

## 3. 查询消息数量

运行以下 SQL 获取消息统计：

```sql
SELECT 
  json_extract(data, '$.role') as role,
  COUNT(*) as count
FROM message 
WHERE time_created/1000 >= {start_timestamp}
AND time_created/1000 < {end_timestamp}
GROUP BY role;
```

## 4. 查询按 Agent + 模型分组的详情

运行以下 SQL：

```sql
SELECT 
  agent,
  json_extract(model, '$.id') as model_id,
  json_extract(model, '$.providerID') as provider,
  COUNT(*) as sessions,
  ROUND(SUM(tokens_input) / 1000000.0, 2) as input_M,
  ROUND(SUM(tokens_output) / 1000000.0, 2) as output_M,
  ROUND(SUM(tokens_reasoning) / 1000000.0, 2) as reasoning_M,
  ROUND(SUM(tokens_cache_read) / 1000000.0, 2) as cache_read_M,
  ROUND(SUM(tokens_cache_write) / 1000000.0, 2) as cache_write_M,
  ROUND(SUM(tokens_input + tokens_output + tokens_reasoning + tokens_cache_read) / 1000000.0, 2) as total_M,
  ROUND(SUM(cost), 4) as cost_usd,
  CASE 
    WHEN SUM(tokens_input) + SUM(tokens_cache_read) > 0 
    THEN ROUND(SUM(tokens_cache_read) * 100.0 / (SUM(tokens_input) + SUM(tokens_cache_read)), 2)
    ELSE 0 
  END as cache_hit_rate
FROM session 
WHERE time_created/1000 >= {start_timestamp}
AND time_created/1000 < {end_timestamp}
GROUP BY agent, model_id, provider
ORDER BY cost_usd DESC;
```

## 5. 查询每个 Agent 的消息数量

运行以下 SQL：

```sql
SELECT 
  json_extract(data, '$.agent') as agent,
  COUNT(CASE WHEN json_extract(data, '$.role') = 'user' THEN 1 END) as user_msgs,
  COUNT(CASE WHEN json_extract(data, '$.role') = 'assistant' THEN 1 END) as asst_msgs
FROM message 
WHERE time_created/1000 >= {start_timestamp}
AND time_created/1000 < {end_timestamp}
GROUP BY agent;
```

## 6. 输出结果

使用以下格式输出统计结果：

```
## 📊 Token 消耗统计 ({时间范围})

### 总览
| 指标 | 值 |
|------|-----|
| Sessions | {total_sessions} |
| 用户消息 | {user_messages} |
| Agent 回复 | {assistant_messages} |
| 总消息数 | {total_messages} |
| 输入 Token | {input_M} M |
| 输出 Token | {output_M} M |
| 推理 Token | {reasoning_M} M |
| 缓存读取 | {cache_read_M} M |
| 缓存写入 | {cache_write_M} M |
| **总 Token** | **{total_tokens_M} M** |
| 缓存命中率 | {cache_hit_rate}% |
| **总费用** | **${total_cost}** |

### 按 Agent + 模型详情

| Agent | 模型 | Sessions | 输入(M) | 输出(M) | 缓存读取(M) | 总计(M) | 缓存命中率 | 费用($) |
|-------|------|----------|---------|---------|------------|---------|-----------|--------|
| {agent} | {model_id} | {sessions} | {input_M} | {output_M} | {cache_read_M} | {total_M} | {cache_hit_rate}% | {cost_usd} |
...
```

## 注意事项

- Token 单位使用 M（百万）
- 费用保留 4 位小数
- 缓存命中率保留 2 位小数
- 按费用从高到低排序
- 使用 `opencode db` 命令执行 SQL 查询，格式使用 `--format json`
