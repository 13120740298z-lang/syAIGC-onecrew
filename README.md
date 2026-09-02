# OneCrew · 一人出海 AIGC 内容官（Video Studio v3）

> **一个人，一支内容小队，一条成片产线。** 面向一人公司（OPC）/ 独立开发者的对话式 AIGC 出海内容智能体。
> SynNovator【Q1W3 第三轮】AIGC 技术赛道 · Wave 3: Agents · 参赛作品（总决赛演进版）

你说一个产品，十位 AI 队友接力完成出海内容全套，**最终直接产出可投放的广告成片 MP4**：

```
🔍 市场快研 → ⏸ 人工确认 → 🎙️ 品牌声音 → ✍️ 五平台文案 → 🎨 提示词工坊
→ 🖼️ AI 直出配图 → 📢 英文旁白 → 🎬 分镜导演 → 🎥 真·广告成片(MP4) → 📅 内容日历 → 🛡️ 合规体检
```

产出可直接落地的工件：市场报告（MD）、品牌声音档案（JSON）、五平台文案包（MD）、
Midjourney/即梦提示词（MD）、**真实 AI 配图（JPG）**、广告分镜脚本（JSON）、
**广告成片（H.264 MP4，16:9 横版 1080p + 9:16 竖版，AI 生图 + 多语言 AI 配音 + Ken Burns 运镜 + 转场/音效 + 双语字幕烧录）**、
7 天内容日历（CSV）、合规体检清单（MD）。
全程步骤可视、可停、可重跑、可复核（每次运行落盘留痕）。

### 视频成片引擎（零 Key 零成本层）

- **生图三级降级链**：Pollinations flux（质量）→ turbo（快速）→ ffmpeg 本地渐变（终极兜底，永不失败）
- **配音**：edge-tts 神经声线，按目标市场映射（日/韩/英/德/法/西/中），旁白语言自动跟随市场
- **AI 视觉质检**：vision 模型逐张评审生图（水印/伪影/畸形检测），不合格自动换种子重绘
- **电影感合成**：2x 超采样运镜（zoom/pan 抗抖动）、xfade 转场、棕噪声 whoosh 音效、双语字幕烧录、片头钩子卡/片尾品牌卡、封面自动抽取

---

## 一键运行

```bash
npm run setup     # 安装依赖（首次）
npm start         # 启动 → 浏览器打开 http://localhost:8787
```

依赖：Node.js ≥ 18；ffmpeg（WinGet `Gyan.FFmpeg` 或任意 PATH 可用版本，媒体引擎自动定位）；
Python + edge-tts（`pip install edge-tts`，配音用）。

- **真实模式**：在 `server/.env` 填入任意 OpenAI 兼容接口的 Key（模板见 `server/.env.example`）。
- **演示模式**：不填 Key 自动降级，全流程照常可跑（确定性产出 + 真实媒体管线照常成片），界面明示"演示模式"。
- 评审无需任何账号，密钥绝不进前端。

## 仓库结构

```
├─ agents/onecrew.agent.json   # Agent 定义（11 步工作流，含人工确认点）
├─ skills/*.json               # 十技能工作流文件（引擎运行时真实加载）
├─ server/                     # 引擎与 API（Node.js/Express，零构建依赖）
│  ├─ runner.js                #   状态机执行器（步骤留痕/取消/重跑/人工确认/上下文接力/媒体引擎直驱）
│  ├─ skills.js                #   技能加载器 + 提示词组装 + 安全闸
│  ├─ router.js                #   意图路由器（关键词 + LLM 兜底分类）
│  ├─ provider.js              #   双 Provider（真实 LLM → 限流快速换模型 → 降级 Mock）+ 视觉质检
│  ├─ media.js                 #   视频/成图引擎（生图降级链 + edge-tts + ffmpeg 电影感合成）
│  └─ store.js                 #   JSON 文件存储（sessions/runs/artifacts，支持二进制工件）
├─ web/                        # 豆包式前端（React + Vite，含视频播放器/图片预览）
├─ data/                       # 运行留痕（runs/*.json 不可变 + media/ 成片与配图，评审可复核）
├─ exports/                    # 工件落盘（可直接下载的 MD/CSV/JSON）
├─ docs/                       # 调研文稿 / Wave1 Specs / 使用示例 / 提交说明 / 赛前极致分析
└─ screenshots/                # 运行截图证据
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-调研与设计文稿.md](docs/01-调研与设计文稿.md) | 赛事调研 · 市场竞品调研 · 11 节设计开发文档 |
| [docs/02-specs/01-需求确认单.md](docs/02-specs/01-需求确认单.md) | Wave 1（Specs）沉淀 |
| [docs/03-使用示例与复现步骤.md](docs/03-使用示例与复现步骤.md) | 使用示例 · 复现步骤 · 验收清单 |
| [docs/04-提交说明-Wave3.md](docs/04-提交说明-Wave3.md) | 提交主文档：入口/能力/IO/调用方式/Wave3 更新说明/评分自查 |
| [docs/06-赛前极尽分析报告.md](docs/06-赛前极尽分析报告.md) | 交叉评测复盘 · 竞品极致分析 · 总决赛冲刺决策 |
