# P34 稳智对齐 P3 #15 图片多模态

## 改动清单

### 1. chat-core.ts（加多模态消息块类型）
- 新增 `ImageUrlPart` / `TextPart` / `ContentPart` 类型（OpenAI 兼容接口格式）
- 不改 `PromptPiece.content` 类型（仍是 string），避免连锁影响

### 2. chat/route.ts（ChatBody 加 images 字段 + injectImages 函数）
- ChatBody 加 `images?: string[]` 字段（base64 data URL 数组）
- 新增 `injectImages(messages)` 函数：把 body.images 转成 image_url content block，追加到最后一轮 user message 的 content 数组里
- 只认以 `data:image/` 开头的字符串；其他形状一律丢弃（不报错，向后兼容）
- 没有 images 或最后一轮不是 user message 时不动任何字段
- 所有 `buildMessages(turn)` / `buildMessagesWz(turn)` 调用改为 `injectImages(buildMessages(turn))` / `injectImages(buildMessagesWz(turn))`

### 3. use-chat.ts（send 函数透传 images）
- `send` 函数加可选 `images?: string[]` 参数
- `requestExtras` 加 `images?: string[]` 字段
- extras 里 `...(images && images.length > 0 ? { images } : {})`（没图时 body 里没有 images 键，向后兼容）

### 4. AssistantPage.tsx（图片上传按钮 + 预览）
- 导入 `ImagePlus` / `X` 图标
- 新增 `images` state（base64 data URL 数组）+ `fileInputRef`
- 新增 `handleImageUpload` 函数：用 FileReader.readAsDataURL 把图片转 base64，放进 images 数组
- 新增 `removeImage` 函数：删除指定索引的图片
- submit 函数把 images 传给 send（发送后清空）
- 空状态输入区：加图片上传按钮 + 隐藏 file input + 图片预览条（缩略图 + 删除按钮）
- 非空状态输入条：同样加图片上传按钮 + 隐藏 file input + 图片预览条

### 5. p34-image-upload.test.ts（9 条新钉测）
- 3 条 images 过滤测试（只收 data:image/ 开头的字符串 / 空数组 / 非数组）
- 6 条 injectImages 测试（有图片时改 content 为数组 / 没图片原样返回 / 无效形状原样返回 / 最后一轮不是 user 不动 / 最后一轮 content 已是数组不覆盖 / 多张图片全部追加）

## 验证
- tsc 0 错误
- p34-image-upload 9/9 全绿
- 全量 1300/1310 pass（1 fail 是 p2-archive-db CJS top-level await 老问题，本轮之前就跳过）
- next build 通过

## 稳智口径
- HTML 侧栏 `<input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple>` ✅
- payload `images: []`（数组） ✅
- 前端不压缩、不缩放、直接上传原图 ✅
- 服务端决定用哪个多模态 LLM（本仓库透传给 OpenAI 兼容接口，由上游决定） ✅

## 已知限制
- 前端不压缩、不缩放（稳智口径），大原图（>10MB）可能导致 API 超时
- 没有做文件大小限制（稳智也没有，纯缺）
- LLM 需要支持 vision 能力（OpenAI 兼容接口需支持 image_url content block）；不支持时会返回 400 错误
- 图片只跟这一轮绑定，不跨轮继承（发送后清空）