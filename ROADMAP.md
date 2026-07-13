# FencerPath 商业化路线图 (v2 — 渐进式方案)

_最后更新: 2026-07-13_

## 现状

- 功能完整的单页 vanilla JS 应用(`index.html`),业务逻辑经过多轮验证:排名合并(VM/EM vs National 优先级)、资格赛 C1/C2 卫星赛规则、跨联合会赛事去重、证件(SVFF/EFC/FIE)自动判断、Priority Inbox 推荐引擎等。
- 纯本地 `localStorage` 存储,无账号系统、无云同步、无付费墙、无 tier gating 逻辑。
- 部署现状:`main` 分支为完整源码(生产环境是 Vercel,域名 `fencerpath.se`);`gh-pages` 分支只放精简版 `index.html`,作为早期/备用镜像。两者需要在阶段三整理清楚。

## 决策:不做整体 Next.js 重写

有外部建议(见 2026-07-13 对话)提出 5-6 周整体重构成 Next.js + Supabase + Stripe + AI 的方案。评估后决定**不采用整体重写**,原因:现有代码里大量业务逻辑是踩坑踩出来的(多个 session 反复修复的排名/资格赛/证件边界情况),重写有很高的"重写陷阱"风险——容易在迁移过程中把已经修好的 bug 重新引入。改为**渐进式路径**:保留现有业务逻辑内核,只在外围加云同步、AI、支付能力。

## 阶段一:账号 + 云同步(预估 1.5–2 周)

- Supabase 项目:Auth(Email + Google,Apple 可后续加)+ 一张 `user_data` 表,每用户一条 JSON blob,结构对应现有 `State` 对象(fencers/competitions/registrations/scoringRules/settings 等)。
- 把 `save()` / 数据加载函数改成读写 Supabase,而不是 `localStorage`,尽量不动其余业务逻辑代码。
- 首次登录的"本地数据迁移"流程:把浏览器里现有 localStorage 数据一次性导入新账号。
- 多设备同步验证。
- **里程碑**:你和邀请的朋友能各自用自己的账号登录,数据互不干扰,换设备也能看到同样数据。

## 阶段二:AI Coach + Stripe(预估 1.5–2 周)

- AI Coach 设计原则:规则引擎算出的"事实"(排名、资格赛门槛、截止日期)保持不变、保持权威,新增一层用 OpenAI API 把这些事实转成自然语言建议——**不让 AI 替代规则判断**,避免因 AI 算错资格赛门槛这类有真实后果的错误。
- 测试期 AI Coach 先不设付费墙,加用量上限(如每人每天 N 次)控制 API 成本。
- Stripe 接入:Free(1 个选手 + 核心功能:赛程/排名/资格赛/证件跟踪)/ Pro(多选手 + AI Coach + 赛季规划)。需要从零搭建 tier gating 逻辑(目前完全没有)。
- **里程碑**:付费墙能跑通一次完整流程(选套餐 → Stripe 支付 → 解锁 Pro 功能)。

## 阶段三:正式上线准备(预估 1 周)

- 官网 / Landing Page,定位更新为 **"FencerPath — AI Platform for Competitive Fencing"**。
- 隐私政策、数据导出/备份说明。
- 整理 gh-pages 与 Vercel 的部署混乱(建议只保留 Vercel 为正式环境)。
- 正式邀请更大范围用户测试。

## 暂不列入近期计划

- 整体重写成 Next.js:等阶段一二跑通、验证了付费意愿后,可作为独立的代码质量优化项目,不影响这次上线节奏。
- 国家配置抽象层(北欧扩展):现在做还太早,优先把瑞典市场做深做透,资源不应分散。

## 总预估

约 4–5 周,比"整体重写"方案略短,风险更低——阶段一二都是在现有、已验证的业务逻辑基础上"加能力",而不是"换实现"。
