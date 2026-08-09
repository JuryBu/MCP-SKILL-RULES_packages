# 微信数据库技术参考

## 1. 微信 4.1+ 数据库概览

微信 4.1+ 使用 WCDB（基于 SQLCipher 4）加密存储所有本地数据。加密数据库位于 `db_storage/` 目录下，按功能分为约 18 个 `.db` 文件。

### 1.1 关键数据库文件

| 文件 | 用途 | 本系统是否使用 |
|---|---|---|
| `message/message_0.db` | 消息主库，每个会话一张 `Msg_<MD5(username)>` 表 | ✅ 核心 |
| `contact/contact.db` | 联系人、群信息、群成员 | ✅ 昵称解析 |
| `session/session.db` | 会话列表和未读状态 | ❌ 不使用 |
| `group/group.db` | 群组详情 | ❌ 不使用 |
| `misc/misc_*.db` | 杂项配置 | ❌ 不使用 |
| 其他 | 媒体缓存、表情等 | ❌ 不使用 |

本系统只读取 `message_0.db` 和 `contact.db`，不写入任何微信数据库。

### 1.2 为什么只读 2 个数据库？

- `message_0.db` 包含所有会话的消息记录，是消息入账的唯一来源
- `contact.db` 提供发送者昵称映射，让事件载荷包含人类可读的发送者名称
- 其他数据库对消息入账无直接价值，减少读取范围也降低安全风险

## 2. 密钥提取原理

### 2.1 SQLCipher 4 加密结构

微信使用的 SQLCipher 4 加密参数：

| 参数 | 值 | 说明 |
|---|---|---|
| 页大小 | 4096 字节 | 每页独立加密 |
| 盐值大小 | 16 字节 | 存储在数据库文件前 16 字节 |
| 预留区 | 80 字节 | 每页尾部存 IV + HMAC |
| IV 大小 | 16 字节 | 每页随机初始化向量 |
| HMAC 大小 | 64 字节 | 每页 HMAC-SHA512 校验 |
| KDF | PBKDF2-HMAC-SHA512 | 密钥派生函数 |
| KDF 迭代 | 256000 次 | SQLCipher 4 默认 |

### 2.2 密钥从哪里来？

微信进程在内存中持有主密钥。本系统使用的外部工具 `wcdb_key_tool_windows.py` 通过扫描微信进程内存中的 `Config.Cipher` 结构来提取密钥，而非传统的 raw key 扫描。

**为什么 raw key 扫描失败？**

早期尝试直接在进程内存中搜索 32 字节随机密钥（即"raw key"），但：
- 微信 4.1+ 不再把 raw key 以连续字节存储在固定位置
- `Config.Cipher` 结构包含派生密钥和加密参数，不是简单的 raw key
- 直接搜索会找到大量误报的 32 字节序列

**为什么 Config.Cipher 扫描成功？**

`Config.Cipher` 是 WCDB 内部的密钥管理结构，包含：
- 派生后的数据库密钥
- 加密参数（页大小、KDF 迭代次数等）
- 数据库文件路径映射

通过扫描这个结构的特征模式（而非搜索随机密钥），可以精确定位 18/18 个数据库的密钥。

### 2.3 密钥提取工具

工具路径由环境变量 `WECHAT_KEY_TOOL` 指定，默认为：
```
~/.codex-toolkit/wechat-docs-mcp/private-state/tools/wcdb_key_tool_windows.py
```

两个子命令：
- `extract` — 从运行中的微信进程提取密钥，输出到 JSON 文件
- `decrypt` — 用密钥文件解密指定目录的所有 .db 文件

`DbWatcher.refresh_keys()` 调用 `extract`，`DbWatcher.decrypt_changed()` 调用 `decrypt`。

## 3. 消息表结构

### 3.1 表名计算

WCDB 为每个会话创建独立的消息表，表名为 `Msg_` + MD5(username)：

```python
def _msg_table_name(username: str) -> str:
    return "Msg_" + hashlib.md5(username.encode("utf-8")).hexdigest()
```

例如 `wxid_abc123` 的消息表名是 `Msg_<md5("wxid_abc123")>`。

群聊的 username 格式是 `xxxxxxxx@chatroom`。

### 3.2 消息表字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `local_id` | INTEGER | 本地递增 ID，用于基线追踪 |
| `server_id` | INTEGER | 服务器端消息 ID |
| `local_type` | INTEGER | 消息类型编码 |
| `sort_seq` | INTEGER | 排序序列号 |
| `real_sender_id` | INTEGER | 发送者 ID（关联 Name2Id.rowid） |
| `create_time` | INTEGER | Unix 时间戳 |
| `status` | INTEGER | 消息状态 |
| `source` | TEXT | 消息来源 XML |
| `message_content` | TEXT/BLOB | 消息内容（可能 zstd 压缩） |
| `compress_content` | TEXT/BLOB | 压缩内容 |
| `packed_info_data` | BLOB | 打包信息 |
| `WCDB_CT_message_content` | INTEGER | 压缩类型标志（0=raw, 4=zstd） |
| `WCDB_CT_source` | INTEGER | source 字段的压缩类型 |

### 3.3 Name2Id 表

`message_0.db` 中的 `Name2Id` 表将 `rowid` 映射到 `user_name`（wxid）：

```sql
CREATE TABLE Name2Id (user_name TEXT, is_session INTEGER DEFAULT 0);
```

`real_sender_id` 字段引用此表的 `rowid`。`DbObserver._load_sender_cache()` 在初始化时加载此映射。

## 4. zstd 解压

### 4.1 为什么需要 zstd？

微信 4.1+ 对较长的消息内容使用 zstandard 压缩。`WCDB_CT_message_content` 字段标志压缩类型：
- `0` — 未压缩，直接 UTF-8 文本
- `4` — zstd 压缩，需要解压

### 4.2 解压实现

```python
import zstandard as zstd
_ZDCTX = zstd.ZstdDecompressor()

def _decompress_field(data, ct: int) -> str:
    if ct == 0:
        return data.decode("utf-8", errors="replace")
    if ct == 4 and _ZDCTX is not None:
        return _ZDCTX.decompress(data).decode("utf-8", errors="replace")
```

`zstandard` 是 Python 的 zstd 绑定，在 `pyproject.toml` 中声明为依赖。

### 4.3 如果 zstandard 未安装？

`db_observer.py` 在 import 时 try/except，`_ZDCTX = None` 时压缩字段返回空字符串。系统不会崩溃，但压缩消息的内容会丢失。`pyproject.toml` 已声明 `zstandard>=0.22,<1` 依赖。

## 5. 消息类型分类

### 5.1 local_type 编码

`_classify_message()` 根据 `local_type` 分类消息：

| local_type | 分类 | 说明 |
|---|---|---|
| 1 | `text` | 文字消息 |
| 3 | `image` | 图片 |
| 34 | `voice` | 语音 |
| 43 | `video` | 视频 |
| 47 | `sticker` | 表情 |
| 48 | `location` | 位置 |
| 49 | `app` | 应用消息（需 XML 子分类） |
| 10000 | `system` | 系统消息 |
| 10002 | `revoke` | 撤回消息 |

### 5.2 App 消息子分类

`local_type=49` 时解析 XML 中的 `<appmsg/type>` 进一步分类：

| appmsg/type | 分类 | 说明 |
|---|---|---|
| 5 | `link` | 链接分享 |
| 6 | `file` | 文件 |
| 33, 36 | `mini_program` | 小程序 |
| 51 | `unknown_app` | 未知应用消息 |
| 其他 | `app` | 通用应用消息 |

### 5.3 敏感度标记

| 消息类型 | sensitivity | 说明 |
|---|---|---|
| text, system, revoke, link | `normal` | 可直接处理 |
| image, file, sticker | `awaiting_owner_instruction` | 需主人后续指令 |

附件类消息先入账缓冲，不触发立即回复，等主人后续文字指令合并处理。

## 6. 联系人映射

### 6.1 发送者名称解析流程

```
real_sender_id (INTEGER)
    → Name2Id.rowid 映射
    → user_name (wxid_xxx 或 xxx@chatroom)
    → contact.db 查 nick_name
    → sender_display (人类可读昵称)
```

### 6.2 缓存策略

- `_sender_cache`: `Name2Id` 全表加载到内存，`rowid → user_name`
- `_contact_cache`: 按需查询 `contact.db`，`username → nick_name`，LRU 缓存

### 6.3 群成员计数

`get_route_identity()` 对群聊路由查 `chatroom_member` 表获取成员数，用于路由身份校验。成员数变化会触发 quarantine。

## 7. 去重指纹

每条消息的 `source_fingerprint` 格式：

```
<username>:<local_id>:<server_id>
```

- `username` — 会话的 wxid 或 chatroom ID
- `local_id` — 该会话消息表中的本地递增 ID
- `server_id` — 微信服务器分配的消息 ID

`events` 表的 `UNIQUE(route_id, source_fingerprint)` 约束保证同一消息不会重复入账。即使 `watch_once` 重试导致同一条消息被多次观察到，`ingest_event` 的 `INSERT ... UNIQUE` 也会拒绝重复插入。
