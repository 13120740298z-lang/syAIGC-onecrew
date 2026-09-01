# OneCrew · 一人出海 AIGC 内容官

> **一个人，一支内容小队。** 面向一人公司（OPC）/ 独立开发者的对话式 AIGC 出海内容智能体。
> SynNovator【Q1W3 第三轮】AIGC 技术赛道 · Wave 3: Agents · 方向一：AI 工具 / Agent 方向 · 参赛作品

你说一个产品，**八位 AI 队友接力**完成出海内容全套——不仅写文案，还**真出图、真出片**：

```
🔍 市场快研 → ⏸ 人工确认 → 🎙️ 品牌声音 → ✍️ 五平台文案 → 🎨 图像提示词
→ 🖼️ 视觉工坊（AI 真出图 ×4） → 🎬 短片导演（15 秒竖屏带货成片）
→ 📅 内容日历 → 🛡️ 合规体检
```

**行业唯一带合规体检的全链路 AI 内容流水线**：调研了 8 家同台竞品（Predis / Simplified / Canva / InVideo / Fliki / CapCut / HeyGen / KreadoAI），合规体检环节覆盖数为 **0**。而 TikTok Shop 官方要求日更 ≥1 条视频、60% 卖家每周耗 6-10 小时做内容、78% 卖家搞不定广告合规、近 40% 卖家首年被限权/封号、UGC 外包 $45-212/条——OneCrew 用一条流水线把这一切压到 **≈1.2 元/次**（LLM + 生图 + TTS 真实记账）。

---

## 🏁 端到端真实运行凭证（2026-09-02）

一条用户输入「我的产品是智能保温杯，316不锈钢12小时保温，想卖日本，帮我出全套出海内容」，
真实 LLM 模式（deepseek-v4-flash）完整跑通 **9/9 步 · 183 秒 · 产出 13 个工件**：

| # | 步骤 | 耗时 | 产物 |
|---|---|---|---|
| s1 | 市场快研 | 39.9s | 市场快研报告.md |
| s2 | **人工确认**（可批准/驳回） | — | 用户确认后继续 |
| s3 | 品牌声音定位 | 10.2s | 品牌声音档案.json |
| s4 | 五平台文案 | 29.5s | 五平台文案包.md（TikTok/IG/亚马逊/独立站/EDM） |
| s5 | 图像提示词 | 20.1s | 图像提示词包.md（Midjourney/即梦） |
| s6 | 视觉工坊 | 9.6s | **产品图集 ×4 PNG** + 生成参数清单 |
| s7 | 短片导演 | 14.6s | **15秒带货短视频.mp4**（1080×1920 h264+aac，16.5s）+ 分镜脚本 |
| s8 | 7天内容日历 | 16.7s | 内容日历.csv（Excel 直接打开） |
| s9 | 合规体检 | 19.1s | 合规体检清单.md（广告法/文化禁忌逐条核对） |

- 短片成片规格：**1080×1920 竖屏 · h264 High 30fps · AAC 旁白 + BGM ducking 混音 · 4 镜 Ken Burns 动效 + xfade 转场 + ASS 字幕**，旁白为 TTS 真实配音（按市场语言自动选声线：en/zh/ja/ko），分镜复用 s6 上游产品图。
- 留痕可复核：本次运行完整记录在 [`data/runs/r_mtj4b85qm6thi.json`](data/runs/r_mtj4b85qm6thi.json)（61 条 append-only 事件逐步留痕），工件原件在 [`exports/`](exports/)，通过前端工作台可预览/下载（图片、视频直接在线播放）。
- **第二份留痕（确认点即编辑点）**：批准前修订「语言=日语」，下游旁白/字幕/日历全部改按日语产出、日文神经声线真实配音——[`data/runs/r_mtj62q7csutgb.json`](data/runs/r_mtj62q7csutgb.json)（9/9 步 · 567s · 13 工件）。
- **成本仪表盘（真实记账）**：前端「成本」页签读取 `/api/stats`，当前累计 **10 次真实运行共 ¥1.32**（单次全流程 ≈ ¥1.04，对照 UGC 外包 $45-212/条）。

## 上下游接力（这次修复的核心）

每步完成后，执行器把上游工件摘要注入下游 `params.context`（run 级共享），形成真正的**接力**而非各自为战：

```
市场快研 ──差异化角度──▶ 品牌声音 ──tone/slogan──▶ 五平台文案 ──hook/CTA──▶ 图像提示词
                                                                              │ 真实生图
                        合规体检 ◀── 全链路产出 ◀── 内容日历 ◀── 短片导演 ◀── 视觉工坊
                        （体检对象 = 实际产出的文案，不是空谈）
```

短片导演**直接复用**视觉工坊生成的 4 张产品图作为分镜素材；合规体检审的是 s1–s8 的真实产出内容。

## 一键运行

```bash
npm run setup     # 安装依赖（首次）
npm start         # 启动 → 浏览器打开 http://localhost:8787
```

- **真实模式**：在 `server/.env` 填入任意 OpenAI 兼容接口的 Key（模板见 `server/.env.example`）。
- **媒体层（全部可选）**：`ARK_API_KEY`（火山 Seedream 4.0 生图，约 0.2 元/张）或 `SILICONFLOW_API_KEY`（Kolors 免费）即为真图；TTS 默认走 Edge 免费引擎。**不配则自动降级本地「构图小样/静音分镜」演示，全流程照常跑通，界面明示演示模式**——评审无需任何账号。
- **密钥绝不进前端、绝不提交仓库**（`server/.env` 已 gitignore）。

## 仓库结构

```
├─ agents/onecrew.agent.json   # Agent 定义（9 步工作流，含人工确认点）
├─ skills/*.json               # 8 技能工作流文件（Wave 2 沉淀 + v2 新增视觉工坊/短片导演）
├─ server/                     # 引擎与 API（Node.js/Express，零构建依赖）
│  ├─ runner.js                #   状态机执行器（上下文接力/步骤留痕/取消/重跑/人工确认）
│  ├─ skills.js                #   技能加载器 + output_type 分流（text/json/images/video）+ 安全闸
│  ├─ router.js                #   意图路由器（关键词 + LLM 兜底分类）
│  ├─ provider.js              #   双 Provider（真实 LLM → 失败/无 Key 降级 Mock）
│  ├─ media.js                 #   v2 媒体层：文生图（Seedream/Kolors）+ TTS（Edge/CosyVoice）
│  ├─ ffmpeg.js                #   v2 合成层：1080×1920 成片（Ken Burns/xfade/ASS 字幕）
│  └─ store.js                 #   JSON 文件存储（sessions/runs/artifacts，二进制工件 Range 流式服务）
├─ web/                        # 豆包式前端（React + Vite，dist 已预构建；图片/视频在线预览播放）
├─ data/                       # 运行留痕（runs/*.json 不可变、append-only 事件，评审可复核）
├─ exports/                    # 工件落盘（MD/CSV/JSON/PNG/MP4，可直接下载）
├─ docs/                       # 调研文稿 / Wave1 Specs / 使用示例 / 提交说明 / v2 总纲
└─ screenshots/                # 运行截图证据
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-调研与设计文稿.md](docs/01-调研与设计文稿.md) | 赛事调研 · 市场竞品调研 · 11 节设计开发文档 |
| [docs/02-specs/01-需求确认单.md](docs/02-specs/01-需求确认单.md) | Wave 1（Specs）沉淀 |
| [docs/03-使用示例与复现步骤.md](docs/03-使用示例与复现步骤.md) | 使用示例 · 复现步骤 · 验收清单 |
| [docs/04-提交说明-Wave3.md](docs/04-提交说明-Wave3.md) | 提交主文档：入口/能力/IO/调用方式/Wave3 更新说明/评分自查 |
| [docs/07-v2开发总纲.md](docs/07-v2开发总纲.md) | v2 升级总纲：竞品调研 · 技术实测 · 架构 · 交付顺序 |
| [docs/08-v2路演讲稿.md](docs/08-v2路演讲稿.md) | 决赛路演讲稿：三金句 · 演示脚本 · 评委对比表 · Q&A 预案 |
| [roadshow/README.md](roadshow/README.md) | **对比视频**（95.7s 1920×1080）：分镜表 · 旁白脚本 · 重建步骤 |
| [docs/ppt/](docs/ppt/) | **路演 PPT**（9 页，深蓝主题，python-pptx 生成，可再生成） |
| [docs/09-部署手册.md](docs/09-部署手册.md) | 在线 Demo 部署：香港轻量服务器直装全流程 + 故障排查 |

## 🚀 在线部署

评委/用户公网访问的部署步骤见 **[docs/09-部署手册.md](docs/09-部署手册.md)**（首选香港轻量服务器直装：Ubuntu 24.04 + Node 22 + fonts-noto-cjk + systemd 常驻；nginx 反代须 `proxy_buffering off` 保 SSE 实时性）。密钥只在服务器 `server/.env`，不进仓库。
