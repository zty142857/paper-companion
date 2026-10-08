# 论文阅读智能学伴 · 项目交接文档

> 最后更新：2026-10-05（安全加固 + 解析/概要/术语/画像多项改进后）
> 项目目录：`/home/dongzhihua/zone2/paper-companion/`
> 用途：参赛《电信T.A杯》"AI+教育"创新应用技能大赛 **赛道一（AI+高等教育）**，选题定位「AI+教学 · 智能学伴」
> 用户使用说明见同目录 `USER_GUIDE.md`。

---

## 1. 项目目标

面向研究生/高年级本科生的**论文阅读智能学伴 Web 应用**，核心卖点：

1. 上传 PDF → 智能体自动生成全文导读（研究问题/方法/创新点/实验/局限，带原文页码锚点，可点击跳页）+ 逐级章节概要（目录式）+ 术语卡
2. **真实版面精读**（pdf.js 渲染原版 PDF + 透明文本层可选中复制），不是重排网页
3. 点击任意段落 → 翻译 / 发起子对话；回答强制带 `[块ID]` 出处引用，原文无依据时诚实声明
4. **子对话/翻译/术语以卡片形式锚定在论文旁边，可拖拽重新锚定**（核心创新交互）
5. 智能体属性：摸底问卷画像 → 自主生成"阅读计划"（可见、可调整）→ 按需生成内容；需要时自主调用 arXiv/S2 检索（过程气泡可见）
6. 主动交互：读完全篇自测（要点判分、错题引导回原文）
7. 记忆：跨论文档案（按领域存摸底结果、已懂术语跳过、收藏文献库、基于历史的论文推荐、一键文献综述）

### 评审采分点对照（满分100）
| 维度 | 分值 | 我们的抓手 |
|---|---|---|
| 场景适配性 | 20 | 智能学伴定位对齐赛道一原文；研究生文献阅读痛点 |
| 技术规范性 | 25 | 块级出处引用、事实自查、人工纠错、**隐私声明 + 一键清除（已完成）** |
| 创新优化性 | 20 | 卡片锚定拖拽交互、阅读计划可视化、逐级目录概要、术语按需解释卡 |
| 实施显著性 | 25 | **需要真实试用数据**（阶段五：找3-5位同学试用留痕） |
| 推广适配性 | 10 | 纯 Web、用户自填 API Key、低部署门槛、跨平台启动脚本 |

### 关键时间线
- 报名截止 **10月10日**（用户自行在官方平台注册）
- 作品提交截止 **10月25日**：简介表+承诺书(PDF扫描件)、作品介绍文档(PDF)、演示视频(MP4 ≤10min ≤500MB：概述≤2min+核心场景≤6min+总结≤2min)、支撑材料(选填)
- 文件命名：`赛道名称+作品名称+负责人姓名+学校`
- 比赛方案原文：`/home/dongzhihua/zone2/西安交通大学《电信T.A杯》"AI+教育"创新应用技能大赛比赛方案.docx`

### 已达成的产品决策（勿推翻）
- 只做 **B1 方案**：真实版面 + 边栏卡片轨（不做分块重建视图）
- 跳转只到**页**，不画段落高亮框；坐标仅用于点击命中测试
- 术语不在原文标亮；术语以**右轨小卡**呈现，点击展开为解释卡
- 单栏论文：左栏节概要+术语，右轨卡片
- 摸底问卷结果**按领域标签**存档案；同领域再上传时"沿用/重新摸底"；阅读计划**展示给用户且可调整**
- 引用文献**只展示 DOI，不代下载**
- 收藏制：上传自动记"浏览过"，手动收藏进"文献库"才参与推荐和综述
- 已懂术语直接跳过不解释
- 自测**只在全篇读完后**触发（或顶部按钮）
- API Key 处理：**绝不硬编码进应用**。用户在工作台「设置」自填 Base URL/Key/模型/思考强度，存 SQLite（GET 时掩码回显）。开发测试 Key 在 `backend/.env`（已 gitignore + 权限 600）
- 团队若以学生为主体须至少 1 名教师（用户自行处理）

---

## 2. 技术栈与运行方式

| 层 | 选型 |
|---|---|
| 前端 | Vite 8 + React 19 + TS + pdfjs-dist 6.3.289（无路由库，hash 路由） |
| 后端 | Python 3.14 + FastAPI + PyMuPDF 1.28 + openai SDK（兼容模式） |
| 存储 | SQLite（`backend/data/app.db`）+ PDF 原件（`backend/data/pdfs/`） |
| LLM | OpenAI 兼容（默认阿里 DashScope，模型 `qwen3.8-flash`），思考强度 none/low/medium/high（仅 qwen3+dashscope 时带 `enable_thinking`+`thinking_budget` extra_body，失败自动降级重试） |
| 外部检索 | arXiv API + Semantic Scholar API（免费无需 Key） |

### ⚠️ 环境要求
- **Node.js ≥ 20.19 或 ≥ 22.12**（Vite 8 强制要求；旧版 Node 会导致 vite 启动但**不监听端口**）
- **Python 3.14**（用 `uv` 建虚拟环境，无需系统 pip）

### 启动
```bash
cd /home/dongzhihua/zone2/paper-companion && bash start.sh
# backend: http://127.0.0.1:8000  frontend: http://127.0.0.1:5173
# vite 已配 /api 代理到 8000，前端同源访问
```
依赖安装（新环境）：
```bash
uv venv backend/.venv --python 3.14
uv pip install -p backend/.venv fastapi "uvicorn[standard]" pymupdf httpx openai python-multipart
cd frontend && npm install && npm install pdfjs-dist @rolldown/binding-linux-x64-gnu
# 注：npm 可选依赖 bug 需手动补装 rolldown binding；构建命令 npm run build（tsc -b && vite build）
```
> 跨平台启动（Windows/mac/Linux/WSL）见 `USER_GUIDE.md`。

### 模型配置
- 优先读数据库 `setting` 表（用户在工作台「设置」填写），其次读 `backend/.env`，最后内置默认值。
- `.env.example` 提供模板；分享他人时**删除 `backend/.env`**（含真实 Key），使用者自填即可。

### 测试论文
- `A comprehensive static model of cable-driven multi-section...pdf`（19页，单栏，Elsevier，公式多，**主演示用**）
- `Continuum Robots: An Overview`（Russo 2023，25页，双栏，Wiley 综述，层级多）
- 其余见 `backend/data/pdfs/`（本地生成，不入库）

---

## 3. 架构与数据模型

### 目录
```
paper-companion/
├─ start.sh                  # 一键启动
├─ PROJECT.md                # 本文档
├─ USER_GUIDE.md             # 用户使用说明（功能介绍 + 跨平台打开方式）
├─ backend/
│  ├─ .env / .env.example    # LLM 默认配置（.env 勿提交）
│  └─ app/
│     ├─ main.py             # FastAPI 路由（全部接口）
│     ├─ db.py               # SQLite：paper/setting/card/profile/paper_meta 五表 + 权限收紧 + 一键清除
│     ├─ pdf_parse.py        # ★ PDF→块树解析（页→栏→节→段）
│     ├─ llm.py              # OpenAI 兼容客户端 + tone_hint（熟悉度语气）+ 配置读取(.env→DB覆盖)
│     ├─ summarize.py        # 导读：elements/selfcheck/outlines(逐级一句话)/terms（含 plan/familiarity/term_depth 提示）
│     ├─ ai.py               # 块级：translate / explain_term / chat（上下文拼装 + 自主检索 steps）
│     ├─ profile.py          # 猜领域/阅读计划/推荐/综述（term_depth 由熟悉度规则推导）
│     ├─ quiz.py             # 全篇自测出题 + 简答判分（按熟悉度调难度）
│     └─ search.py           # arXiv + Semantic Scholar + DOI 抽取
└─ frontend/src/
   ├─ api.ts                 # 接口封装 + 全部 TS 类型
   ├─ App.tsx                # hash 路由：#/ 首页，#/paper/:id 工作台
   ├─ Home.tsx               # 上传 + 论文列表 + 备注 + 文献综述 + 隐私与数据
   ├─ PaperView.tsx          # ★ 工作台：导读/卡片轨/工具条/计划卡/检索/记忆
   ├─ PdfViewer.tsx          # ★ pdf.js 渲染+文本层+命中测试+blockTop + 缩放滑块/横向滚动
   ├─ CardItem.tsx           # 翻译/子对话卡：拖拽/折叠/删除确认/类型色条/宽度拖拽
   ├─ TermItem.tsx           # ★ 术语小卡（未点击）→ 展开为解释卡
   ├─ Markdown.tsx           # 轻量 markdown 渲染（消息/综述共用）
   ├─ ProfileModal.tsx       # 摸底问卷
   ├─ PlanCard.tsx           # 阅读计划展示与勾选调整（确认后触发自动导读）
   ├─ QuizModal.tsx          # 全篇自测
   └─ SettingsModal.tsx      # 模型设置
```

### 核心数据结构（块树）
```ts
Block { id:"b12", page, col, type:"para"|"heading"|"figure"|"formula",
        y0,y1,x0,x1 /*PDF点,左上原点*/, size /*字号*/, text, section_id }
Section { id:"s3", title, level, page, heading_block_id, is_references, outline }
Paper.structure = { title, pages, blocks[], sections[] }   // 存 DB JSON
Analysis = { elements[{kind,text,refs,pages,checked}], outlines[{section_id,outline}], terms[{term,zh,expl,refs,pages}] }
Card { id, paper_id, type:"translation"|"chat"|"term", block_id /*锚点*/, top /*px*/,
       data:{offset?, width?, translation, orig, page | block_ids, messages[], term, zh, expl, collapsed, pending} }
paper_meta = 领域/熟悉度/known_terms/dismissed_terms/plan/note/quiz_score/visited/collected/domain_guess
```

### 解析算法要点（pdf_parse.py，改动前必读）
- **分栏**：正文块左边缘 x0 对齐密度聚类（dominant 组 ≥ max(4, 12%~22%) 且组距≥150pt），对通栏标题/脚注/公式免疫
- **标题**：**匹配数字编号标题（`HEADING_RE`，如 `2.1.`、`2.3.1.`）即判为标题**；其余情况需「字号>正文1.12倍 或 加粗 或 斜体」且匹配 References / 全大写模式，字母占比>0.35
  - 2026-10 修复：此前斜体子节标题（如 Elsevier 的 `2.1.`）与同字号纯文本标题会被漏判，导致章节概要不全。现编号标题直接判为标题。
- **公式碎片**：字母占比<0.25 且含数字 → type=formula（不进 LLM digest）
- **竖排水印**：line dir 纵向的丢弃
- **标题提取**：PDF metadata 优先，否则首页顶部字号最大的单段
- 已知不足：跨页延续的节不做合并；参考文献节整节跳过 digest；论文的 section 顺序按 (栏, 页内 y) 而非编号数字排序

### 章节概要层级（summarize._gen_outlines）
- 层级 = 标题数字编号的**段数**：`1`→篇、`1.1`→章、`1.1.1`→节；无编号标题（REVIEW、正文开头、References）跳过
- 一次 LLM 调用为所有编号 section 各生成**一句话**概要；篇概整范围、章概本章、节概本节
- 标题多时 `max_tokens` 按节数动态放大；漏生成的标题会补一轮
- 前端左栏按 depth 缩进显示（目录式）

### 卡片定位数学（PdfViewer.blockTop）
`cardTop = pageEl.getBoundingClientRect().top - railRect.top + block.y0 * pageScale + data.offset`
- 拖拽松手 → 遍历所有块找最近锚点 → PATCH `{block_id, top, data.offset}`
- 防重叠：术语卡与普通卡统一按锚定 top 排序依次下推（仅视觉，不改锚定）

### API 一览
```
POST /api/papers                 上传+解析（解析后后台预生成领域猜测）
GET  /api/papers | /api/papers/{id} | /api/papers/{id}/pdf | /api/papers/{id}/analysis
DELETE /api/papers/{id}          删除论文（连带卡片/档案/PDF 文件）
POST /api/papers/{id}/analyze    导读（4次LLM并行：要素→自查 / 节概要 / 术语；节概要按层级，术语按 term_depth）
GET/POST /api/papers/{id}/cards  POST {type,block_id,top,data}
PATCH/DELETE /api/cards/{cid}
POST /api/papers/{id}/translate  {block_id} → {translation,page}
POST /api/papers/{id}/term       {term,zh,refs} → 按需生成术语解释（按 term_depth 调详略）
POST /api/papers/{id}/chat       {block_ids,history,question} → {answer,refs,pages,steps[]}（按 familiarity 调语气）
GET/PUT /api/settings            base_url/api_key(掩码)/model/effort
POST /api/data/clear             一键清除全部本地数据（论文/卡片/档案/PDF；清 Key 保留模型配置）
GET  /api/papers/{id}/profile    猜领域 + 同领域旧档案 + 本篇 meta
POST /api/papers/{id}/survey     {domain,familiarity,known_terms,reuse} → meta
POST /api/papers/{id}/plan       生成阅读计划（1次LLM；term_depth 由熟悉度规则推导）
PUT  /api/papers/{id}/plan       保存用户勾选调整后的计划
POST /api/papers/{id}/dismiss_term  {term} → 隐藏某术语小卡（持久化）
POST /api/search                 {q,source:arxiv|s2|both,doi} → {results[]}
GET  /api/papers/{id}/refs       从参考文献节正则抽取 DOI
POST /api/papers/{id}/collect    {collected:bool}
POST /api/papers/{id}/note       {note} → 论文备注
GET  /api/papers/{id}/recommend  基于档案+历史+计划推荐 3 篇（带个性化理由）
POST /api/review                 {paper_ids[]} ≥2篇 → 生成对比综述（带各篇 focus）
POST /api/papers/{id}/quiz       全篇自测出题（2选择+1简答；按 familiarity 调难度）
POST /api/papers/{id}/quiz/grade 简答按要点判分
```

---

## 4. 已完成任务 ✅

### 阶段一：骨架
- 项目初始化、依赖、一键启动
- PDF 解析管线（标题/分栏/节/公式识别）
- LLM 客户端（思考强度、掩码、降级重试）+ 设置页
- 全文导读六要素 + 页锚点跳页 + 节概要侧栏
- pdf.js 原版面渲染 + 文本层选中复制
- 布局：导读置顶通栏 → 下滑进入阅读区

### 阶段二：核心交互
- 段落点击 → 命中测试 → 浮动工具条（翻译/提问/通俗讲解）
- 翻译卡（占位卡先显，译文返回后填充）
- 子对话卡（多轮、`[bID]`引用、页码跳转、持久化、轻量 markdown）
- 术语提取 + 点击成卡
- 卡片拖拽重锚定 + 防重叠 + 折叠/删除；激活置顶
- 可信性：要素事实自查（✓已自查）；chat 强制出处引用+诚实拒答

### 阶段三：智能体
- 摸底问卷 + 用户档案（领域级 + 每篇）
- 阅读计划编排器（可勾选调整后保存）
- 外部检索：arXiv + S2 + 参考文献 DOI 抽取
- chat 自主检索（步骤气泡）
- 记忆：术语按已懂跳过、收藏、推荐、文献综述
- 删除论文、论文备注

### 阶段四：主动与打磨
- 全篇自测（2选择+1简答、错题回原文、得分入库）
- analyze 性能优化（4次LLM并行）
- **安全加固**：隐私声明弹窗 + 一键清除数据 + `.env`/数据目录权限收紧（600/700，启动自动）

### 阶段五（本轮新增改进）
- **领域猜测提速**：仅凭标题+摘要，术语走本地词典 / 未命中才让模型生成；上传后台预生成，`/profile` 秒回
- **术语交互**：右轨琥珀色小卡（未点击）→ 点击就地展开为解释卡（按需生成）；删除小卡永久隐藏；类型色条区分卡片种类
- **章节概要**：按题号层级（篇/章/节）逐级生成**一句话**概要，目录式缩进
- **解析修复**：识别斜体/同字号编号子节标题
- **阅读计划驱动提示词**：`focus`/`skip` → 影响导读要素侧重、推荐/综述关注点；`abstract_emphasis` → 影响「一句话总览」侧重
- **熟悉度驱动**：新手/进阶/熟手 → 影响子对话、导读、章节概要的语气，及自测难度；无画像（手动路径）不加任何特殊提示
- **流程**：完成摸底+计划并点「按此计划进行」→ 自动生成导读（含术语/章节概要）；推荐/导读也可手动生成（无特殊提示）
- **UI**：卡片宽度可拖拽、卡片删除确认、消息 markdown 渲染、阅读区边界着色/加宽、缩放改滑块、170% 适配 + 内部横向滚动
- **文献综述**移到主页（勾选论文生成）
- **privacy**：隐私声明 + 一键清除

---

## 5. 尚未完成任务 📋

### 阶段五：参赛材料（下一对话从这里开始）
1. 组织 3-5 位同学真实试用留痕（截图/问卷数据 → "实施显著性"）
2. 作品介绍文档 PDF（作品名/3-5关键词/概要/痛点/创新点/落地场景/应用成效）
3. 演示视频（≤10min，脚本突出：阅读计划生成→检索气泡→卡片拖拽锚定→自测→综述）
4. 简介表+承诺书 PDF、按命名规范打包提交

### 已知小问题（不阻塞）
- 卡片 `data.offset` 在缩放后不换算（视觉小偏移，可接受）
- formula 块未渲染成截图
- 跨页节标题合并未做
- section 顺序按页面位置而非编号数字（个别子节顺序错位）
- 首页上传同名论文不去重
- Semantic Scholar 免费接口易 429 限流（arXiv 为主）
- 计划/推荐/综述/自测为一次性面板，无历史留存
- analyze 耗时波动（取决于 provider 负载）
- `_discard` 后旧论文 structure 需重新上传才应用新解析

---

## 6. 开发环境备忘（WSL）

- Node：需 ≥20.19/≥22.12（可用 `~/.nvm/versions/node/v24.19.0/bin`，旧版 22.0.0 会导致 vite 不监听端口）
- Python 3.14（无系统 pip，用 `~/.local/bin/uv`）
- 后端重启后需确认端口监听：`(ss -ltnp || netstat -ltnp) | grep -E '5173|8000'`
- 单次 bash 命令若阻塞（如 start.sh 前台）会被工具 120s 超时杀掉子进程，用 `setsid ... &` 完全脱离
- 浏览器自动化测试（agent-browser）需要 libs/字体，`/tmp/opencode` 重启会清空；命令模板：
```bash
export LD_LIBRARY_PATH=/tmp/opencode/rootfs/usr/lib/x86_64-linux-gnu
export FONTCONFIG_FILE=/tmp/opencode/fonts.conf AGENT_BROWSER_SESSION=pc-dev
agent-browser open "http://127.0.0.1:5173/#/paper/<id>"
```
- 缺库：`apt-get download libnss3 libnspr4 libasound2t64` 解包到 `/tmp/opencode/rootfs`
- 缺中文字体：`fonts-noto-cjk` 解包到 `/tmp/opencode/fonts`（约 61MB，下载慢）
- 测试产生的卡片数据在 DB 里，演示前到首页删除或用「隐私与数据 → 一键清除」

## 7. 给下一个对话的开场建议

> 先读 `PROJECT.md` 与 `USER_GUIDE.md`，从「阶段五：参赛材料」开始，遵循已锁定的产品决策，不要重新讨论方案。用户使用/跨平台启动请看 `USER_GUIDE.md`。
