# 赛鸽参赛报名与休药期复核台

由“赛鸽血统环号登记站”扩展而来，在档案/血统/转让/成绩之上增加赛事报名、休药禁赛候补、解除复核与更正重算。

运行：

```bash
npm start      # http://localhost:3024
npm test       # 业务规则测试（node --test）
```

## 分层（入口 / 资格计算 / 报名存储分开）

| 文件 | 职责 |
| --- | --- |
| `server.js` | HTTP 入口与页面，只做路由和参数搬运 |
| `registry.js` | 领域服务：报名编排、并发去重、更正触发重算、复核校验 |
| `eligibility.js` | 纯资格计算：禁赛截止、资格判定、名额/候补排布（不碰存储） |
| `store.js` | 报名与档案存储：串行化读-改-写、原子落盘、旧数据迁移 |

## 核心规则

1. **唯一有效报名**：同一足环号同一赛事只保留一份报名；重复或并发报名沿用首次结果（进程内去重 + 存储层串行写）。
2. **报名前置**：必须绑定报名时的当前鸽主（报名记录留存鸽主快照，转让不改绑），且血统已确认（父母均已登记）。
3. **休药禁赛**：禁赛截止日 = 用药日 + 休药天数。休药期覆盖比赛日且未解除时，报名只能进候补，不得占正式名额；正式名额按报名先后发给无禁赛者。
4. **他人复核解除**：复核人不得是施药人，复查日不得早于禁赛截止。解除后立即重算，候补可按报名顺序晋升正式。
5. **更正即失效重算**：更正用药（解除随之作废）、血统（确认失效）、放飞日或名额，未结束赛事的名额与候补立即重排；已完赛赛事封存历史，只追加“受影响”标记。
6. **一致刷新**：榜单的正式名额、候补、失效与完赛历史都由同一份数据即时派生，刷新后一致。

## API 摘要

- `POST /api/events`、`GET /api/events`、`GET /api/events/:id/board`
- `PATCH /api/events/:id`（放飞日/名额更正）、`POST /api/events/:id/finalize`（完赛封存）
- `POST /api/events/:id/registrations`（报名，幂等）
- `POST /api/pigeons`、`GET /api/pigeons`、`GET /api/pigeons/:ring/relation`
- `POST /api/pigeons/:ring/transfers|races|vaccines`
- `PATCH /api/pigeons/:ring/bloodline`、`POST /api/pigeons/:ring/bloodline/confirm`
- `POST /api/pigeons/:ring/medications`、`PATCH .../medications/:medId`、`POST .../medications/:medId/release`

错误码如 `bloodline_unconfirmed`、`withdrawal_hold`、`reviewer_must_differ`、`review_before_suspension_end`、`event_finalized` 等见 `registry.js`。
