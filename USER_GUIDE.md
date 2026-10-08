# 论文阅读智能学伴 · 使用说明

一个帮你**高效读论文**的本地 Web 应用：上传 PDF 后自动生成全文导读与章节概要，支持在原版面上翻译/提问/查术语，读完后还能自测，并把读过、收藏的论文串成推荐与综述。

> 所有数据（论文、笔记、卡片）都保存在**你自己的电脑**上。只有调用 AI 功能时，相关论文片段会发送到你配置的模型服务商。

---

## 目录
1. [功能一览](#1-功能一览)
2. [第一次使用：配置模型](#2-第一次使用配置模型)
3. [各功能怎么用](#3-各功能怎么用)
4. [在不同系统上打开（Windows / WSL / Linux / macOS）](#4-在不同系统上打开)
5. [常见问题](#5-常见问题)
6. [隐私与数据](#6-隐私与数据)

---

## 1. 功能一览

| 功能 | 说明 |
|---|---|
| **上传论文** | 拖拽或点击上传 PDF，自动解析标题、章节、段落（约 5–15 秒） |
| **摸底问卷** | 上传后自动弹窗：识别论文领域，问你熟悉度、勾选已懂术语 |
| **阅读计划** | 根据你的画像生成可调整的阅读计划（重点关注/建议略读/阅读建议） |
| **全文导读** | 六要素（一句话总览/研究问题/方法/创新点/实验与结果/局限），带页码可点击跳转，并做事实自查 |
| **章节概要** | 左栏目录式列出「篇/章/节」，每项一句话概要 |
| **原版面精读** | pdf.js 渲染原始 PDF，可选中复制；缩放滑块，>170% 可左右滑动 |
| **段落翻译** | 点击任意段落 → 翻译成中文（术语保留英文+白话注释） |
| **子对话** | 对某段提问，回答带 `[块ID]` 出处；话题涉及外部/最新进展时会自主检索 arXiv |
| **术语卡** | 右轨列出术语小卡，点击展开为解释卡（按需生成，贴合论文语境） |
| **卡片锚定** | 翻译/对话/术语卡可拖拽重新锚定到段落旁，可调整宽度、折叠、删除 |
| **文献检索** | 直接在应用内检索 arXiv / Semantic Scholar |
| **收藏与记忆** | 收藏论文进文献库；已懂术语跳过；推荐基于你的阅读历史 |
| **文献综述** | 主页勾选 ≥2 篇论文，一键生成对比综述 |
| **全篇自测** | 读完后出 2 选择题 + 1 简答题，错题可跳回原文 |
| **隐私与数据** | 查看数据说明，一键清除全部本地数据 |

---

## 2. 第一次使用：配置模型

应用本身不含 API Key，需要你自备一个**兼容 OpenAI 接口**的模型服务。

### 支持的服务
任何 OpenAI 兼容接口都可以，例如：
- 阿里云 DashScope（默认）：`https://dashscope.aliyuncs.com/compatible-mode/v1`，模型如 `qwen3.8-flash`
- DeepSeek、Moonshot、智谱、OpenAI、本地 Ollama/vLLM 等

### 配置步骤
1. 打开应用，点右上角「**模型设置**」。
2. 填写：
   - **Base URL**：服务商的 OpenAI 兼容地址
   - **API Key**：你的密钥（保存在本机，回显时打码）
   - **模型名**：如 `qwen3.8-flash`
   - **思考强度**：低/中/高（影响速度与质量；部分模型不支持会自动降级）
3. 保存即可。

> 若模型服务商在 `backend/.env` 里预置了配置，也可以不填（优先用网页里填的）。

---

## 3. 各功能怎么用

### 3.1 上传与摸底
- 首页把 PDF 拖到虚线框，或点击选择文件。
- 进入工作台后**自动弹出摸底问卷**：确认/修改领域 → 选熟悉度（新手/进阶/熟手）→ 勾选已懂术语 → 提交。
- 同领域论文会显示「沿用上次摸底」。

### 3.2 生成导读
- 完成摸底后会**自动生成阅读计划**；在计划卡上勾选调整后点「**按此计划进行**」，应用会**自动生成导读**（含章节概要、术语）。
- 也可以直接点顶部「**生成全文导读**」手动生成（不套用画像）。
- 导读里每条要素带页码按钮，点击跳到对应页。

### 3.3 精读与互动
- 在 PDF 区域**点击任意段落** → 弹出工具条：翻译此段 / 就此段提问 / 通俗讲解。
- 生成的卡片出现在右侧轨道，**拖动卡片头**可重新锚定到别的段落；拖右边缘可改宽度；✕ 删除（有确认）。
- 子对话可多轮追问；回答里的 `[块ID]` 表示出处，页码按钮可跳转。

### 3.4 术语
- 左栏「术语卡」区域列出术语；未看过的显示为琥珀色小卡，点击就地展开成解释卡。
- 小卡上的 ✕ 可永久隐藏该术语。

### 3.5 检索 / 推荐 / 综述
- 导读区下方检索框可搜 arXiv / Semantic Scholar。
- 顶部「**推荐**」按你的阅读历史推荐 3 篇。
- 主页「**文献综述**」→ 勾选 ≥2 篇 → 生成对比综述。

### 3.6 全篇自测
- 滚到全文末尾会出现提示条，或点顶部「**全篇自测**」。
- 做完提交判分，错题会显示正确答案、解析和「回原文」按钮。

---

## 4. 在不同系统上打开

应用分**后端（Python）**和**前端（Node）**两部分，先装依赖，再一键启动。

### 通用前置要求
- **Node.js ≥ 20.19 或 ≥ 22.12**（Vite 8 要求；版本太低会导致页面打不开）
- **Python 3.14** + 包管理器 [uv](https://docs.astral.sh/uv/)（推荐），或系统 pip
- 能联网（首次装依赖 + 调用模型）

---

### 4.1 Linux

```bash
# 1. 安装 Node（建议用 nvm）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc && nvm install 22 && nvm use 22

# 2. 安装 uv
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"     # 或加入 ~/.bashrc

# 3. 装依赖
cd paper-companion
uv venv backend/.venv --python 3.14
uv pip install -p backend/.venv fastapi "uvicorn[standard]" pymupdf httpx openai python-multipart
cd frontend && npm install && npm install pdfjs-dist @rolldown/binding-linux-x64-gnu && cd ..

# 4. 启动
bash start.sh
# 打开浏览器访问 http://127.0.0.1:5173
```

---

### 4.2 macOS

```bash
# 1. 安装 Homebrew（若没有）后装 Node 与 uv
brew install node uv

# 2. 装依赖（注意：rolldown binding 平台名不同）
cd paper-companion
uv venv backend/.venv --python 3.14
uv pip install -p backend/.venv fastapi "uvicorn[standard]" pymupdf httpx openai python-multipart
cd frontend && npm install && cd ..

# 3. 启动
bash start.sh
```
> Apple Silicon 一般无需手动补 rolldown binding；若 `npm run dev` 报缺少 binding，执行 `npm install @rolldown/binding-darwin-arm64`（Intel 用 `-darwin-x64`）。

---

### 4.3 Windows（推荐用 WSL2）

**方式 A：WSL2（推荐，最省心）**
1. 管理员 PowerShell 执行 `wsl --install`，装好 Ubuntu 后进入 WSL。
2. 在 WSL 里按上面 **4.1 Linux** 的步骤操作。
3. 启动后，在 **Windows 的浏览器**里访问 `http://127.0.0.1:5173`（WSL2 默认端口会被转发，通常可直接访问）。
4. 代码建议放在 WSL 文件系统（如 `~/paper-companion`）而非 `/mnt/c/...`，速度更快。

**方式 B：原生 Windows（PowerShell）**
```powershell
# 1. 安装 Node（官网 LTS，或 winget install OpenJS.NodeJS）与 uv（winget install astral-sh.uv）
# 2. 装依赖
cd paper-companion
uv venv backend\.venv --python 3.14
uv pip install -p backend\.venv fastapi "uvicorn[standard]" pymupdf httpx openai python-multipart
cd frontend; npm install; cd ..

# 3. 分别起后端和前端（start.sh 是 bash 脚本，Windows 下用两条命令）
# 后端（新开一个 PowerShell 窗口）
backend\.venv\Scripts\uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
# 前端（再开一个窗口）
cd frontend; npm run dev -- --host 127.0.0.1
```
然后浏览器访问 `http://127.0.0.1:5173`。
> 若缺 rolldown binding：`npm install @rolldown/binding-win32-x64-msvc`。

---

### 4.4 一键启动脚本 `start.sh`
```bash
#!/bin/bash
cd "$(dirname "$0")"
# 检查依赖 → 关掉旧后端 → 起后端 → 起前端
bash start.sh
```
- 日志：`/tmp/pc-backend.log`、`/tmp/pc-frontend.log`
- 停止：`pkill -f '[u]vicorn app.main'` 和 `pkill -f vite`
- 改了**后端**要重启后端；改了**前端** Vite 会自动热更新。

---

## 5. 常见问题

**Q：浏览器打不开 `http://127.0.0.1:5173` / 页面空白？**
先确认 Node 版本（`node -v` ≥ 20.19/22.12）。旧版 Node 会让 Vite 启动但不监听端口。用 `ss -ltnp | grep 5173` 看端口是否在监听。

**Q：报「未配置 API Key」？**
到「模型设置」填 Base URL / Key / 模型名。

**Q：生成导读很慢或失败？**
导读要并行调用 4 次模型，耗时 30–110 秒，取决于服务商负载。失败可重试；或在设置里把思考强度调低。

**Q：上传后没有章节概要 / 术语？**
需先完成摸底 + 确认阅读计划（或手动点「生成全文导读」）。若某论文解析不出章节，属 PDF 版式特殊情况。

**Q：想重新开始？**
主页「隐私与数据 → 一键清除全部数据」，会删除所有论文/卡片/档案/PDF 并清除已保存的 Key。

**Q：`npm run build` 报找不到 rolldown binding？**
npm 可选依赖的已知 bug，手动补装对应平台的包（见上面各系统说明）。

---

## 6. 隐私与数据

应用首页「**隐私与数据**」按钮内也有以下说明：

- **数据存储**：论文原文、导读/术语/卡片、阅读计划、笔记，全部存在**本机** `backend/data/`（SQLite + PDF），不上传到本应用以外的服务器。数据目录权限已收紧为仅当前用户可读。
- **模型调用**：生成导读、翻译、术语解释、子对话、自测时，会把**相关论文正文片段与你的提问**发送到你配置的模型服务商用于推理。请仅上传你有权处理的论文，并留意服务商的隐私政策。
- **API Key**：仅存本机（`backend/.env` 或本机数据库，权限 600），不回显明文、不写日志、不对外发送（仅用于调用你配置的模型）。
- **你的权利**：可逐篇删除论文，或「一键清除全部数据」。

> 分享给他人时：删除 `backend/.env`（含你的真实 Key），对方按第 2 节自行配置即可。仓库根目录 `.gitignore` 已忽略 `.env` 与 `backend/data/`。
