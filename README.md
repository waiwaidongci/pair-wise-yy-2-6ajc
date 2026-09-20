# 赛鸽登记站 · 参赛报名与休药期复核台

运行：

```bash
npm start
```

访问 `http://localhost:3024`。支持档案、血统查询、转让、归巢成绩，以及赛事报名、名额/候补管理与用药休药期复核。

测试：

```bash
npm test
```

## 结构（入口、资格计算与报名存储分离）

- `server.js` — HTTP 入口与页面，只做路由和参数解析。
- `lib/eligibility.js` — 资格计算（纯函数）：禁赛截止日、休药期覆盖判定、名额与候补重算。
- `lib/entries.js` — 领域操作：报名、用药登记/更正、复核解除、血统确认/更正、放飞日更正。
- `lib/store.js` — 报名与档案存储：JSON 持久化 + 串行事务锁。

## 规则

- **报名唯一**：同一羽同一赛事只保留一份有效报名；重复或并发请求沿用首次结果（写操作串行化，天然幂等）。
- **报名绑定**：报名时校验并绑定当前鸽主（`owner_mismatch` 拒绝），且血统须已确认，否则只能候补。
- **休药期**：禁赛截止日 = 用药日 + 休药天数；休药期覆盖比赛日（含截止日当天）即禁赛，未解除前只能候补、不得占正式名额。
- **失效重算**：更正用药、血统或放飞日会使相关报名与候补排序立即失效，按首次报名顺序重算；已完赛历史保留但标记「受影响」及原因。更正用药后原解除作废，需重新复核；更正血统后须重新确认。
- **复核解除**：解除禁赛须另一人复核（复核人 ≠ 录入人，`reviewer_must_differ`），且复查日不早于禁赛截止日（`review_before_ban_end`）。
- **一致性**：名额、候补与历史由同一份存储在事务内重算后落盘，刷新后一致。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/pigeons` | 档案列表 / 建档 |
| GET | `/api/pigeons/:ring/relation` | 血统查询（父母、子代） |
| POST | `/api/pigeons/:ring/transfers` `/races` `/vaccines` | 转让 / 成绩 / 免疫 |
| POST | `/api/pigeons/:ring/medications` | 登记用药 `{date,name,withdrawalDays,recordedBy}` |
| PATCH | `/api/pigeons/:ring/medications/:i` | 更正用药（解除作废、重算） |
| POST | `/api/pigeons/:ring/medications/:i/lift` | 复核解除 `{reviewedBy,reviewDate}` |
| POST | `/api/pigeons/:ring/pedigree/confirm` | 确认血统 `{confirmedBy}` |
| PATCH | `/api/pigeons/:ring/pedigree` | 更正血统（失效重算） |
| GET/POST | `/api/events` | 赛事看板（名额+候补）/ 创建赛事 |
| PATCH | `/api/events/:id` | 更正放飞日（失效重算） |
| POST | `/api/events/:id/entries` | 报名 `{ringNo,owner}`，幂等 |
