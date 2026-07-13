# 比赛推荐逻辑说明

> 本文档解释推荐系统的评分原理、各参数的含义，以及如何调整权重或添加新条件。
> 代码位置：`index.html` 中的 `scoreReco()` 函数 和 `GOAL_WEIGHTS` 常量。

---

## 一、总体流程

每场即将到来的比赛都会经过以下步骤：

```
1. 筛选（Eligibility）  ←  剑种、年龄组、性别、未报名、未取消
2. 打分（scoreReco）    ←  5 个维度各 0–5 分，加权平均
3. 排序（sort）         ←  综合分从高到低
4. 展示（Top 4）        ←  仅显示最高分的几场
```

---

## 二、筛选条件（Eligibility）

以下任一条件不满足即排除，不进入打分：

| 条件 | 说明 |
|------|------|
| 比赛未取消 | `cancelled !== true` |
| 剑手武器匹配 | 比赛的 `weapon` 在剑手 `weapons[]` 中 |
| 年龄组合法 | 剑手当前年龄组可以参加（同级或高级，不可降级） |
| 性别匹配 | 比赛包含剑手的性别 |
| 未报名 | 该剑手在此比赛还没有有效报名记录 |
| 非非欧洲大洲锦标赛 | 过滤掉非洲、泛美、英联邦等赛事 |

**如何添加新的筛选条件：**
在 `recommendFor()` 函数的 `eligible` 过滤器中，仿照现有 `if (!xxx) return false;` 的写法加一行即可。

---

## 三、五个评分维度

每个维度单独打 0–5 分，最终按目标权重加权平均得到综合分（0–100）。

### 维度 1：战略匹配度（Strategic Fit）

**问题：这场比赛对剑手的赛季目标有多重要？**

| 目标 | 高分条件 | 低分条件 |
|------|---------|---------|
| 🎯 qualify_vm_em（冲VM/EM） | 有确认的选拔资格（5分）；SE/Nordic锦标赛（4分，condition 1） | EC但无资格（2分）；普通国际赛（1分） |
| 📈 build_ranking（建立排名） | SE锦标赛或Nordic锦标赛（5分，小赛场高产分）；有积分规则关联（5分） | EC（1分，不适合建排名）；无关联的FIE赛事（2分） |
| 🌍 gain_experience（积累经验） | FIE/WC（5分）；EFC/EC有资格（4分） | EC无资格（1–2分，无法参加） |
| 🏃 maintain（保持状态） | 本国/北欧赛事（5分）；北欧地区其他（4分） | FIE/EFC（2分） |

**调整方式：** 修改 `scoreReco()` 中 `// ─── 1. STRATEGIC FIT` 部分的数字。

---

### 维度 2：积分价值（Points Opportunity）

**问题：参加这场比赛能获得多少对目标有用的积分？**

关键逻辑：

- **qualify_vm_em**：只有选拔赛或 SE/Nordic 锦标赛（condition 1）才有高分。排名越靠近入选线（4–16名）的剑手分数越高，因为他们积分提升空间最大。
- **build_ranking**：SE锦标赛5分、Nordic锦标赛4分（小赛场 → 名次好 → 多积分）。如果比赛填写了 `pointsPool`（参赛人数），则用实际赛场大小 + 剑手排名差距来精确计算。
- **gain_experience**：以赛事级别作为替代指标（FIE=4，EFC=3）。
- **maintain**：关联国内积分规则的赛事=3分，其余=2分。

**调整方式：** 修改 `scoreReco()` 中 `// ─── 2. POINTS VALUE` 部分。

---

### 维度 3：挑战平衡（Challenge Balance）

**问题：这场比赛的难度对剑手是否合适？**

计算方式：
```
adjustedRank = 剑手国内排名 × levelFactor（级别系数）
ratio = adjustedRank ÷ poolSize（预估参赛人数）
```

| ratio 范围 | 分数 | 含义 |
|-----------|------|------|
| ≤ 0.12 | 3 | 太强——容易拿奖但缺少挑战 |
| 0.12–0.30 | 5 | 最佳区间——有竞争力但能取得好成绩 |
| 0.30–0.60 | 4 | 有挑战性但范围内 |
| 0.60–1.10 | 3 | 较难但有现实机会 |
| 1.10–2.00 | 2 | 偏弱——主要是见识 |
| > 2.00 | 1 | 很可能小组出局 |

**级别系数（levelFactor）和预估人数（levelPoolEst）：**

| 级别 | levelFactor | levelPoolEst |
|------|-------------|--------------|
| swedish（SE锦标赛） | 1.0 | 20人 |
| nordic（Nordic锦标赛） | 1.4 | 30人 |
| efc（欧洲锦标赛循环赛） | 2.0 | 55人 |
| ec（欧洲锦标赛） | 2.5 | 60人 |
| fie（世界杯/世锦赛） | 3.0 | 90人 |

> **调整方式：** 修改 `levelPoolEst` 和 `levelFactor` 这两个对象中的数字即可。例如，如果你觉得Nordic锦标赛实际参赛人数更少，把 `nordic: 30` 改成 `nordic: 22`。

---

### 维度 4：出行与后勤（Travel & Logistics）

**问题：出行负担有多重？有无日程冲突？**

旅行区域判断：
```
nordic（瑞典/挪威/丹麦/芬兰/冰岛）→ 无惩罚（+0）
europe（欧洲其他）                 → 轻微惩罚（−0.5）
intercontinental（洲际）           → 重惩罚（−3）→ 分数 < 3 → 显示"洲际旅行+时差"标签
```

其他扣分：
- 同一剑手7天内有其他比赛：每次 −1.5 分
- 同一家庭成员同期有冲突比赛（不同城市）：每次 −2 分

**修改旅行区域的国家列表：** 在 `scoreReco()` 的 `EUROPE_C` 数组中增删国家代码（ISO 3166-1 alpha-3）。

---

### 维度 5：日历适配（Calendar Fit）

**问题：报名窗口是否还开着？距上次比赛是否有足够恢复时间？**

| 情况 | 分数 |
|------|------|
| 报名已截止 | 0 |
| 2天内截止 | 1 |
| 7天内截止 | 2 |
| 21天内截止 | 3 |
| >21天 或 无截止日期 | 4 |

恢复期额外扣分：
- 上场比赛结束后 < 7天：−2
- 7–14天：−1
- ≥ 14天：不扣

---

## 四、目标权重（GOAL_WEIGHTS）

最终综合分 = 五个维度各自分数 × 对应权重，再除以权重之和，标准化到 0–5，再乘以20得到0–100分。

```javascript
const GOAL_WEIGHTS = {
  qualify_vm_em:   { strategic: 2.0, pointsOpp: 1.8, challenge: 0.8, logistics: 0.9, calendar: 1.2 },
  build_ranking:   { strategic: 1.2, pointsOpp: 2.0, challenge: 1.5, logistics: 1.2, calendar: 1.1 },
  gain_experience: { strategic: 0.7, pointsOpp: 0.8, challenge: 2.0, logistics: 1.5, calendar: 1.4 },
  maintain:        { strategic: 0.5, pointsOpp: 0.9, challenge: 0.6, logistics: 2.5, calendar: 2.0 },
};
```

**权重的含义（数字越大 = 这个维度在最终分数中占比越高）：**

| 目标 | 侧重 | 理由 |
|------|------|------|
| qualify_vm_em | 战略(2.0) > 积分(1.8) | 只有对的赛事才有意义 |
| build_ranking | 积分(2.0) > 挑战(1.5) | 要能拿到分，也要有竞争压力 |
| gain_experience | 挑战(2.0) > 日历(1.4) | 难度是最重要的收益 |
| maintain | 后勤(2.5) > 日历(2.0) | 减少负担是第一优先级 |

**如何调整权重：**

直接修改 `GOAL_WEIGHTS` 对象中的数字，比例关系比绝对值更重要。例如，如果你觉得 `qualify_vm_em` 目标下后勤负担应该被更认真对待：
```javascript
qualify_vm_em: { strategic: 2.0, pointsOpp: 1.8, challenge: 0.8, logistics: 1.5, calendar: 1.2 }
//                                                                        ↑ 从0.9改为1.5
```

---

## 五、特殊标签逻辑

除了数字评分，系统还会在卡片上显示徽章（badge）：

| 徽章 | 触发条件 |
|------|---------|
| 🎯 VM/EM 选拔赛 | `qualifiesSelection = true`（scoring rule 中 scope=selection 匹配） |
| SE Championship — condition 1 | 比赛 `level === "swedish"` |
| Nordic Championship — condition 1 | 比赛 `level === "nordic"` |
| ⚠️ Verify qualification | EC级别且无确认选拔资格（`isECLevel && !qualifiesSelection`） |
| Counts for national ranking | scoring rule 中 scope=national 匹配 |

**如何添加新徽章：**
1. 在 `scoreReco()` 的 return 对象中加一个新的布尔字段（如 `isWorldChamp: true`）
2. 在 `recoTile()`、`heroReasons()`、`renderHeroReco()`、`renderDashboard()` 四处的 `qualBadge` 渲染逻辑中增加对应的 `<span class="chip">` 判断

---

## 六、如何增加一个全新的评分维度

例如想增加"报名费用是否合理"这个维度：

**第一步：** 在 `scoreReco()` 中计算新分数：
```javascript
// ─── 6. FEE AFFORDABILITY (0-5) ────────────
const feeAmt = c.feeIndividual?.amount;
let feeScore = 3; // default mid
if (feeAmt !== null && !isNaN(feeAmt)) {
  feeScore = feeAmt <= 200  ? 5
           : feeAmt <= 500  ? 4
           : feeAmt <= 1000 ? 3
           : feeAmt <= 2000 ? 2 : 1;
}
```

**第二步：** 把新维度加入加权平均（在 COMPOSITE 部分）：
```javascript
// 先在 GOAL_WEIGHTS 中每个目标下加 fee: 1.0
const totalW = W.strategic + W.pointsOpp + W.challenge + W.logistics + W.calendar + (W.fee||0);
const rawScore = (... + feeScore * (W.fee||0)) / totalW;
```

**第三步：** 在 return 对象中加 `feeScore`，然后在 `recoTile()` 的 `dimDefs` 数组中加一行：
```javascript
{ key: "fee", label: "报名费", val: s.feeScore, lo: "报名费较高", hi: "报名费合理" },
```

**第四步：** 在两个 i18n 对象（EN 和 SV）中加对应的翻译字符串。

---

## 七、快速参考——调整某个场景的推荐

| 想要的效果 | 修改位置 |
|-----------|---------|
| EC对没有资格的剑手推荐度更低 | `scoreReco()` → strategic / pointsOpp 中 `isECLevel && !qualifiesSelection` 的数字 |
| SE锦标赛对build_ranking目标的权重更高 | `scoreReco()` → `isNatChamp` 的 pointsOpp 数字（目前=5） |
| 欧洲内旅行也应该有轻微惩罚显示 | `scoreReco()` → `travelPenalty` 中 `europe: 0.5` 改为更大的值 |
| 增加一个新的目标类型（如"冲青年世锦赛"） | `GOAL_WEIGHTS` 中加新 key；`scoreReco()` 中每个维度的 if/else 加新分支；`fencerGoalForCategory()` 相关的下拉选项和 i18n 字符串 |
| 改变哪个维度在综合分中更重要 | `GOAL_WEIGHTS` 中对应目标的权重数字 |

---

*最后更新：2026-06-01*
