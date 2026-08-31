# OneCrew · 一人出海 AIGC 内容官

> **一个人，一支内容小队。** 面向一人公司（OPC）/ 独立开发者的对话式 AIGC 出海内容智能体。
> SynNovator【Q1W3 第三轮】AIGC 技术赛道 · Wave 3: Agents · 方向一：AI 工具 / Agent 方向 · 参赛作品

你说一个产品，六位 AI 队友接力完成出海内容全套：

```
🔍 市场快研 → ⏸ 人工确认 → 🎙️ 品牌声音 → ✍️ 五平台文案 → 🎨 提示词工坊 → 📅 内容日历 → 🛡️ 合规体检
```

产出可直接落地的工件：市场报告（MD）、品牌声音档案（JSON）、五平台文案包（MD）、
Midjourney/即梦提示词（MD）、7 天内容日历（CSV，Excel 直接打开）、合规体检清单（MD）。
全程步骤可视、可停、可重跑、可复核（每次运行落盘留痕）。

---

## 一键运行

```bash
npm run setup     # 安装依赖（首次）
npm start         # 启动 → 浏览器打开 http://localhost:8787
```

- **真实模式**：在 `server/.env` 填入任意 OpenAI 兼容接口的 Key（模板见 `server/.env.example`）。
- **演示模式**：不填 Key 自动降级，全流程照常可跑（确定性产出），界面明示"演示模式"。
- 评审无需任何账号，密钥绝不进前端。

## 仓库结构

```
├─ agents/onecrew.agent.json   # Agent 定义（工作流步骤，含人工确认点）
├─ skills/*.json               # 六技能工作流文件（Wave 2 沉淀，引擎运行时真实加载）
├─ server/                     # 引擎与 API（Node.js/Express，零构建依赖）
│  ├─ runner.js                #   状态机执行器（步骤留痕/取消/重跑/人工确认）
│  ├─ skills.js                #   技能加载器 + 提示词组装 + 安全闸
│  ├─ router.js                #   意图路由器（关键词 + LLM 兜底分类）
│  ├─ provider.js              #   双 Provider（真实 LLM → 失败/无 Key 降级 Mock）
│  └─ store.js                 #   JSON 文件存储（sessions/runs/artifacts）
├─ web/                        # 豆包式前端（React + Vite，dist 已预构建）
├─ data/                       # 运行留痕（runs/*.json 不可变，评审可复核）
├─ exports/                    # 工件落盘（可直接下载的 MD/CSV/JSON）
├─ docs/                       # 调研文稿 / Wave1 Specs / 使用示例 / 提交说明
└─ screenshots/                # 运行截图证据
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-调研与设计文稿.md](docs/01-调研与设计文稿.md) | 赛事调研 · 市场竞品调研 · 11 节设计开发文档 |
| [docs/02-specs/01-需求确认单.md](docs/02-specs/01-需求确认单.md) | Wave 1（Specs）沉淀 |
| [docs/03-使用示例与复现步骤.md](docs/03-使用示例与复现步骤.md) | 使用示例 · 复现步骤 · 验收清单 |
| [docs/04-提交说明-Wave3.md](docs/04-提交说明-Wave3.md) | 提交主文档：入口/能力/IO/调用方式/Wave3 更新说明/评分自查 |
