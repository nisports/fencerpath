# FencerPath Tool — 使用说明

## 目录
1. [初始设置 — 添加新剑手](#1-初始设置--添加新剑手)
2. [数据导入顺序](#2-数据导入顺序)
3. [抓取脚本说明](#3-抓取脚本说明)
4. [注意事项 & 已知坑](#4-注意事项--已知坑)

---

## 1. 初始设置 — 添加新剑手

在 `fencerpath-real-data.json` 里手动建档时，需要确认以下字段：

| 字段 | 说明 | 注意 |
|------|------|------|
| `gender` | 性别 | ⚠️ 必须用 `"F"` 表示女性，**不能用 `"W"`**（app 不认识 `"W"`，会显示成 male） |
| `weapons` | 剑种数组 | 只填想追踪的剑种，bio 导入**不会**修改这个字段 |
| `ageCategory` | 主要年龄组 | **⚠️ 必须在导入 bio.json 之前设好**（见下方说明） |
| `ophardtSlug` | Ophardt 个人页面 slug | 格式通常是 `lastname-firstname`，特殊情况可能是纯数字 ID（例如 Henri Ask 的 slug 是 `355843`） |
| `ophardtAthleteId` | Ophardt 运动员 ID | 可从 slug 页面的 URL 参数 `backbiosa=` 中找到 |

---

## 2. 数据导入顺序

### ⚠️ 关键：先设 ageCategory，再导入 bio.json

`nationalRank[weapon]`（卡片上显示的主排名）是在**导入 bio.json 时**根据 `ageCategory` 自动选取的。如果先导入再改 category，排名不会自动更新，需要重新导入 bio.json。

### 正确顺序

```
1. 导入 fencerpath-real-data.json   ← 在 app 里设置好每个剑手的 ageCategory 和 weapons
2. 导入 competitions.json           ← 赛季比赛日历（含取消赛事标注）
3. 导入 bio.json                    ← 填充排名历史、自动更新 nationalRank（不影响 weapons）
4. 导入 swe_rankings.json           ← 同时包含 Nationell Ranking + Uttagning VM/EM，一次搞定
5. 导入 ophardt_results.json        ← 导入各剑手每场比赛的具体成绩（名次+积分）
```

> ✅ **不需要单独导入 vmem_rankings_*.json**
> swe_rankings.json 里的 Uttagning VM/EM 数据与 vmem 文件完全一致，导入 swe_rankings.json 就已经涵盖了。

---

## 3. 抓取脚本说明

`.mjs` 脚本需要在**本地终端**用 `node` 运行（Claude 沙箱内 Node.js fetch 无法访问外网）。  
`.py` 脚本可以直接用 `python3` 运行，在 Claude 沙箱内也可以正常运行。

| 脚本 | 运行方式 | 用途 | 输出文件 |
|------|----------|------|----------|
| `scrape_ophardt.mjs` | `node` | 抓取比赛日历（瑞典国内 + EFC/FIE 国际） | `competitions.json` |
| `scrape_ophardt_bio.mjs` | `node` | 抓取运动员个人传记和排名历史 | `bio.json` |
| `scrape_ophardt_rankings.mjs` | `node` | 抓取 VM/EM 排名列表 | `vmem_rankings_*.json` |
| `scrape_ophardt_swe_rankings.mjs` | `node` | 抓取瑞典国内完整排名（含比赛积分明细） | `swe_rankings.json` |
| `scrape_ophardt_results.py` | `python3` | 抓取各剑手在每场已结束比赛的具体名次和积分 | `ophardt_results.json` |

### scrape_ophardt_results.py 说明

从 Ophardt 公开排名页面（无需登录）抓取每位剑手的每场比赛成绩（名次 + 积分）。

```bash
# 抓取当前赛季（2025/26）
python3 scrape_ophardt_results.py

# 抓取历史赛季
python3 scrape_ophardt_results.py --season=2024

# 调试单个排名页
python3 scrape_ophardt_results.py --id=21859
```

抓取完成后，在 app 里：**Settings → 📊 Pick ophardt_results.json…**

导入会自动：
- 将 Ophardt 运动员名字匹配到工具中的剑手（模糊匹配，支持姓名顺序不同）
- 将比赛名称 + 日期 + 城市匹配到 competitions.json 中的赛事（97%+ 命中率）
- 未命中的比赛（如未抓取的国际赛事）会自动创建 stub 条目
- 为每场已结束的比赛创建或更新 Registration，写入名次和积分
- Qualification Path 的国际赛条件（条件 2）也会自动填充

### 当前5位剑手的 Ophardt 信息

| 剑手 | 剑种 | 性别 | Slug | Athlete ID |
|------|------|------|------|------------|
| Kenneth Kong | Sabre | M | `kong-kenneth` | `422543` |
| Jonathan Lingjue Kong | Foil | M | `kong-jonathan-lingjue` | `395812` |
| Helen Su | Foil | F | `su-helen` | `401786` |
| Henri Ask | Foil | M | `355843` | `355843` |
| Linnea Eriksson | Epee | F | `eriksson-linnea` | `421980` |

> ⚠️ **Henri Ask 特殊情况**：他的 Ophardt slug 是纯数字 `355843`，不是标准的 `lastname-firstname` 格式。

---

## 4. 注意事项 & 已知坑

### 性别字段
- app 使用 `"M"` / `"F"`，Ophardt 原始数据用 `"M"` / `"W"`
- 手动建档时**务必用 `"F"`**，否则女性剑手显示成 male
- 导入 bio.json 后会自动修正（bio 抓取输出的是 `"F"`）

### 瑞典积分系统结构
瑞典有三套积分系统，对我们5位剑手实际有用的是前两套：

| 系统 | 说明 | 覆盖年龄组 |
|------|------|------------|
| **Nationell Ranking** | 瑞典国内比赛积分 | Senior, U20（无佩剑） |
| **Uttagning VM/EM** | VM/EM 选拔排名 | Senior, U17, U20, U23 |
| Masters | 青少年排名 | U15, U17（暂不适用） |

### 多 category 剑手
- 这5位剑手都跨多个 category 参赛，swe_rankings.json 已包含所有相关 category（共22个 ranking）
- 卡片上显示的是 primary ageCategory 对应的排名；完整的 weapon × age 矩阵可在卡片详情里展开查看
- Kenneth Kong 的佩剑在 Nationell Ranking 中**没有**对应列表（该系统不含佩剑）

### 脚本在 Claude 沙箱内运行限制
Node.js 的 `fetch()` 在 Claude Cowork 沙箱内无法连接外网，脚本需要在**本地终端**运行，或由 Claude 用 Python + urllib 替代抓取。
